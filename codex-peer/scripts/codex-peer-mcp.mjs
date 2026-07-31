#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import process from "node:process";

const SERVER_VERSION = "0.1.0";
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const HARD_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const parsedMaxOutputBytes = Number.parseInt(
  process.env.CODEX_PEER_MAX_OUTPUT_BYTES || String(HARD_MAX_OUTPUT_BYTES),
  10,
);
const MAX_OUTPUT_BYTES =
  Number.isInteger(parsedMaxOutputBytes) && parsedMaxOutputBytes >= 1024
    ? Math.min(parsedMaxOutputBytes, HARD_MAX_OUTPUT_BYTES)
    : HARD_MAX_OUTPUT_BYTES;
const MAX_TASK_BYTES = 256 * 1024;
const MAX_RUNNING_JOBS = 4;
const MAX_RETAINED_TERMINAL_JOBS = 50;
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const PEER_DEPTH_ENV = "CODEX_PEER_DEPTH";
const PEER_BRIDGE_NAME = "codex-peer-mcp.mjs";
const CODEX_CLI = process.env.CODEX_PEER_CLI || "codex";
const parsedKillGraceMs = Number.parseInt(process.env.CODEX_PEER_KILL_GRACE_MS || "2000", 10);
const KILL_GRACE_MS =
  Number.isInteger(parsedKillGraceMs) && parsedKillGraceMs >= 10
    ? Math.min(parsedKillGraceMs, 10000)
    : 2000;
const parsedPeerDepth = Number.parseInt(process.env[PEER_DEPTH_ENV] || "0", 10);
const peerDepth = Number.isInteger(parsedPeerDepth) && parsedPeerDepth >= 0 ? parsedPeerDepth : 0;
const isNestedPeer = peerDepth > 0 || hasPeerBridgeAncestor();
const nestedPeerReason = peerDepth > 0 ? `depth ${peerDepth}` : "parent bridge detected";
const RECURSION_GUARD_MESSAGE = `codex-peer is disabled inside nested peer sessions (${nestedPeerReason})`;
const jobs = new Map();
let nextCompletionSequence = 1;

function processField(pid, field) {
  try {
    return execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function hasPeerBridgeAncestor() {
  let pid = process.ppid;
  for (let level = 0; level < 32 && pid > 1; level += 1) {
    const command = processField(pid, "command");
    const executable = command.trim().split(/\s+/, 1)[0] || "";
    const commandWithoutTrailingQuotes = command.trim().replace(/["']+$/, "");
    const isBridgeProcess = commandWithoutTrailingQuotes.endsWith(PEER_BRIDGE_NAME);
    if ((executable === "node" || executable.endsWith("/node")) && isBridgeProcess) return true;
    const parentPid = Number.parseInt(processField(pid, "ppid"), 10);
    if (!Number.isInteger(parentPid) || parentPid <= 0 || parentPid === pid) return false;
    pid = parentPid;
  }
  return false;
}

const tools = [
  {
    name: "codex_peer_review",
    description:
      "Start a read-only second-opinion review in a separate local Codex session and immediately return a job ID. Poll with codex_peer_status, then collect the result with codex_peer_result. The peer cannot edit files.",
    inputSchema: {
      type: "object",
      properties: {
        request: { type: "string", description: "Optional review focus or question." },
        base: { type: "string", description: "Optional branch/ref to compare against." },
        cwd: { type: "string", description: "Workspace path. Defaults to the current workspace." },
        model: { type: "string", description: "Optional Codex model override." },
        effort: { type: "string", description: "Optional reasoning effort override." },
        timeout_seconds: { type: "integer", minimum: 30, maximum: 7200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "codex_peer_delegate",
    description:
      "Start a task in a separate local Codex session and immediately return a job ID. Poll with codex_peer_status, then collect the result with codex_peer_result. Defaults to read-only; set allow_writes=true only when the user explicitly authorizes edits.",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: { type: "string", description: "Task for the peer Codex session." },
        allow_writes: { type: "boolean", description: "Allow edits in the workspace; default false." },
        cwd: { type: "string", description: "Workspace path. Defaults to the current workspace." },
        model: { type: "string", description: "Optional Codex model override." },
        effort: { type: "string", description: "Optional reasoning effort override." },
        timeout_seconds: { type: "integer", minimum: 30, maximum: 7200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "codex_peer_follow_up",
    description:
      "Continue an existing peer Codex thread in the background and immediately return a job ID. Poll with codex_peer_status, then collect the result with codex_peer_result. Defaults to read-only; set allow_writes=true only when the user explicitly authorizes edits.",
    inputSchema: {
      type: "object",
      required: ["thread_id", "task"],
      properties: {
        thread_id: { type: "string" },
        task: { type: "string" },
        allow_writes: { type: "boolean", description: "Allow edits in the workspace; default false." },
        cwd: { type: "string", description: "Workspace path. Defaults to the current workspace." },
        model: { type: "string", description: "Optional Codex model override." },
        effort: { type: "string", description: "Optional reasoning effort override." },
        timeout_seconds: { type: "integer", minimum: 30, maximum: 7200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "codex_peer_start",
    description:
      "Start a peer Codex task in the background and return a job ID. Use codex_peer_status/result/cancel to manage it. Defaults to read-only; set allow_writes=true only with explicit authorization.",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: { type: "string" },
        allow_writes: { type: "boolean", description: "Allow edits in the workspace; default false." },
        cwd: { type: "string", description: "Workspace path. Defaults to the current workspace." },
        model: { type: "string" },
        effort: { type: "string" },
        timeout_seconds: { type: "integer", minimum: 30, maximum: 7200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "codex_peer_status",
    description: "Show the state of a background peer Codex job, or the latest few jobs when no job ID is supplied.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "codex_peer_result",
    description: "Return the stored final result of a completed background peer Codex job.",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: { job_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "codex_peer_cancel",
    description: "Cancel a running background peer Codex job.",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: { job_id: { type: "string" } },
      additionalProperties: false,
    },
  },
];
const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function textResult(text, isError = false) {
  return {
    content: [{ type: "text", text }],
    isError,
  };
}

function jsonRpcError(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function validateToolInvocation(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("tools/call params must be an object");
  }
  if (typeof params.name !== "string" || !toolsByName.has(params.name)) {
    throw new Error(`Unknown tool: ${String(params.name)}`);
  }
  const args = params.arguments ?? {};
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Tool arguments must be an object");
  }
  const schema = toolsByName.get(params.name).inputSchema;
  const properties = schema.properties || {};
  for (const key of Object.keys(args)) {
    if (!(key in properties)) throw new Error(`Unknown argument for ${params.name}: ${key}`);
  }
  for (const key of schema.required || []) {
    if (!(key in args)) throw new Error(`Missing required argument for ${params.name}: ${key}`);
  }
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key];
    if (property.type === "string" && typeof value !== "string") {
      throw new Error(`${key} must be a string`);
    }
    if (property.type === "boolean" && typeof value !== "boolean") {
      throw new Error(`${key} must be a boolean`);
    }
    if (property.type === "integer" && !Number.isInteger(value)) {
      throw new Error(`${key} must be an integer`);
    }
    if (property.minimum !== undefined && value < property.minimum) {
      throw new Error(`${key} must be at least ${property.minimum}`);
    }
    if (property.maximum !== undefined && value > property.maximum) {
      throw new Error(`${key} must be at most ${property.maximum}`);
    }
  }
  return { name: params.name, args };
}

function normalizeArgs(args) {
  const value = args && typeof args === "object" ? args : {};
  const cwd = typeof value.cwd === "string" && value.cwd.length > 0 ? value.cwd : process.cwd();
  const timeoutSeconds = Number.isFinite(value.timeout_seconds)
    ? Math.min(Math.max(Number(value.timeout_seconds), 30), 7200)
    : DEFAULT_TIMEOUT_MS / 1000;
  return {
    ...value,
    cwd,
    timeoutMs: timeoutSeconds * 1000,
    allowWrites: value.allow_writes === true,
  };
}

function formatPeerResult(result) {
  const parts = [];
  const threadId = result.threadId || result.thread_id;
  const jobId = result.jobId || result.job_id;
  if (result.status) parts.push(`status: ${result.status}`);
  if (threadId) parts.push(`thread_id: ${threadId}`);
  if (jobId) parts.push(`job_id: ${jobId}`);
  if (result.text) parts.push(result.text);
  if (result.error) parts.push(`error: ${result.error}`);
  return parts.join("\n\n") || "Codex peer returned no output.";
}

class AppServerClient {
  constructor({ cwd, allowWrites, model, effort, timeoutMs }) {
    this.cwd = cwd;
    this.allowWrites = allowWrites;
    this.model = model;
    this.effort = effort;
    this.timeoutMs = Math.min(timeoutMs, MAX_TIMEOUT_MS);
    this.closed = false;
    this.processGroupId = null;
    this.terminationPromise = null;
    this.nextId = 1;
    this.pending = new Map();
    this.turns = new Map();
    this.stdout = createInterface({ input: this.spawn().stdout });
    this.stdout.on("line", (line) => this.onLine(line));
    this.stderr = this.child.stderr;
    this.stderr.setEncoding("utf8");
    this.stderr.on("data", (chunk) => {
      this.stderrText = `${this.stderrText || ""}${chunk}`.slice(-4000);
    });
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("exit", (code, signal) => {
      if (this.closed) return;
      this.failAll(new Error(`codex app-server exited (${code ?? "unknown"}${signal ? `, ${signal}` : ""})`));
    });
  }

  spawn() {
    this.child = spawn(
      CODEX_CLI,
      ["app-server", "--stdio"],
      {
        cwd: this.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          [PEER_DEPTH_ENV]: String(peerDepth + 1),
        },
        detached: process.platform !== "win32",
      },
    );
    this.processGroupId = process.platform === "win32" ? null : this.child.pid;
    return this.child;
  }

  send(message) {
    if (!this.child.stdin.writable) throw new Error("codex app-server stdin is not writable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for app-server response to ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.send({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.send({ method, params });
  }

  onLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message || JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    this.handleNotification(message);
  }

  failAll(error) {
    if (this.closed) return;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const turn of this.turns.values()) turn.reject(error);
    this.turns.clear();
  }

  handleServerRequest(message) {
    if (message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval") {
      this.send({ id: message.id, result: { decision: this.allowWrites ? "accept" : "decline" } });
      return;
    }
    if (message.method === "item/permissions/requestApproval") {
      this.send({ id: message.id, result: { permissions: [], scope: "turn" } });
      return;
    }
    if (message.method === "item/tool/requestUserInput") {
      this.send({ id: message.id, result: { answers: [] } });
      return;
    }
    if (message.method === "mcpServer/elicitation/request") {
      this.send({ id: message.id, result: { action: "decline", content: null } });
      return;
    }
    this.send({ id: message.id, error: { code: -32601, message: `Unsupported app-server request: ${message.method}` } });
  }

  handleNotification(message) {
    const params = message.params || {};
    if (message.method === "item/completed") {
      const item = params.item || {};
      const turn = this.turns.get(params.threadId || item.threadId);
      if (turn) {
        if (item.type === "agentMessage" && typeof item.text === "string") {
          if (item.phase === "final_answer" || !turn.text) {
            this.updateTurnText(turn, item.text, true);
          }
        }
        if (item.type === "exitedReviewMode" && typeof item.review === "string") {
          this.updateTurnText(turn, item.review, true);
        }
      }
    }
    if (message.method === "item/agentMessage/delta") {
      const turn = this.turns.get(params.threadId);
      if (turn && typeof params.delta === "string") this.updateTurnText(turn, params.delta, false);
    }
    if (message.method === "turn/completed") {
      const completed = params.turn || {};
      const threadId = params.threadId || completed.threadId;
      const turn = this.turns.get(threadId);
      if (turn && (!turn.id || turn.id === completed.id)) {
        if (completed.status === "failed") {
          turn.reject(new Error(completed.error?.message || "Codex peer turn failed"));
        } else if (completed.status === "interrupted") {
          turn.reject(new Error("Codex peer turn was interrupted"));
        } else {
          turn.resolve({ status: completed.status, text: turn.text, threadId: turn.threadId });
        }
        this.turns.delete(threadId);
      }
    }
  }

  updateTurnText(turn, text, replace) {
    const nextText = replace ? text : `${turn.text}${text}`;
    if (Buffer.byteLength(nextText, "utf8") > MAX_OUTPUT_BYTES) {
      turn.reject(new Error(`Codex peer output exceeded ${MAX_OUTPUT_BYTES} bytes`));
      this.turns.delete(turn.threadId);
      return false;
    }
    turn.text = nextText;
    return true;
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "codex_peer_mcp", title: "Codex Peer MCP", version: SERVER_VERSION },
      capabilities: { optOutNotificationMethods: ["item/agentMessage/delta"] },
    });
    this.notify("initialized", {});
  }

  async run({ task, threadId }) {
    await this.initialize();
    const common = {
      cwd: this.cwd,
      approvalPolicy: "never",
      model: this.model,
      effort: this.effort,
    };
    let thread;
    if (threadId) {
      thread = (await this.request("thread/resume", { threadId, cwd: this.cwd })).thread;
    } else {
      thread = (await this.request("thread/start", {
        ...common,
        sandbox: this.allowWrites ? "workspace-write" : "read-only",
      })).thread;
    }
    if (!thread?.id) throw new Error("app-server did not return a thread ID");

    const sandboxPolicy = this.allowWrites
      ? { type: "workspaceWrite", writableRoots: [this.cwd], networkAccess: true }
      : { type: "readOnly", access: { type: "fullAccess" } };
    const started = await this.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: task }],
      ...common,
      sandboxPolicy,
    });
    const turnId = started?.turn?.id;
    return await new Promise((resolve, reject) => {
      this.turns.set(thread.id, { id: turnId, threadId: thread.id, text: "", resolve, reject });
    });
  }

  signalTree(signal) {
    if (process.platform !== "win32" && this.processGroupId) {
      try {
        process.kill(-this.processGroupId, signal);
        return;
      } catch {
        // Fall back to signaling only the direct child.
      }
    }
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    try {
      this.child.kill(signal);
    } catch {
      // The process may have exited between the state check and the signal.
    }
  }

  isProcessTreeAlive() {
    if (process.platform !== "win32" && this.processGroupId) {
      try {
        process.kill(-this.processGroupId, 0);
        return true;
      } catch (error) {
        return error.code !== "ESRCH";
      }
    }
    return Boolean(
      this.child && this.child.exitCode === null && this.child.signalCode === null,
    );
  }

  terminate(reason = "Codex peer stopped") {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
    for (const turn of this.turns.values()) turn.reject(new Error(reason));
    this.turns.clear();
    if (!this.isProcessTreeAlive()) return Promise.resolve();
    if (this.terminationPromise) return this.terminationPromise;
    this.terminationPromise = new Promise((resolve, reject) => {
      let finished = false;
      let pollTimer;
      let killTimer;
      let confirmationTimer;
      const finish = (error) => {
        if (finished) return;
        finished = true;
        clearInterval(pollTimer);
        clearTimeout(killTimer);
        clearTimeout(confirmationTimer);
        if (error) reject(error);
        else resolve();
      };
      this.signalTree("SIGTERM");
      pollTimer = setInterval(() => {
        if (!this.isProcessTreeAlive()) finish();
      }, 10);
      killTimer = setTimeout(() => {
        this.signalTree("SIGKILL");
        confirmationTimer = setTimeout(() => {
          if (this.isProcessTreeAlive()) {
            finish(new Error("Codex peer process group survived SIGKILL"));
          } else {
            finish();
          }
        }, 1000);
      }, KILL_GRACE_MS);
    });
    return this.terminationPromise;
  }
}

function runWithTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Codex peer timed out after ${Math.round(timeoutMs / 1000)} seconds`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function pruneTerminalJobs() {
  const terminalJobs = [...jobs.values()]
    .filter((job) => job.status !== "running" && job.status !== "cancelling")
    .sort((left, right) => left.completionSequence - right.completionSequence);
  const excess = terminalJobs.length - MAX_RETAINED_TERMINAL_JOBS;
  for (let index = 0; index < excess; index += 1) jobs.delete(terminalJobs[index].jobId);
}

function transitionJobToTerminal(job, status, result) {
  if (job.status !== "running" && job.status !== "cancelling") return false;
  job.status = status;
  job.result = result;
  job.finishedAt = new Date().toISOString();
  job.completionSequence = nextCompletionSequence++;
  return true;
}

function startJob(args, threadId = null) {
  const value = normalizeArgs(args);
  if (typeof value.task !== "string" || value.task.trim() === "") throw new Error("task is required");
  if (Buffer.byteLength(value.task, "utf8") > MAX_TASK_BYTES) {
    throw new Error(`task exceeds ${MAX_TASK_BYTES} bytes`);
  }
  if (threadId !== null && (typeof threadId !== "string" || threadId.trim() === "")) {
    throw new Error("thread_id is required");
  }
  const runningJobs = [...jobs.values()].filter(
    (job) => job.status === "running" || job.status === "cancelling",
  ).length;
  if (runningJobs >= MAX_RUNNING_JOBS) {
    throw new Error(`Codex peer already has ${MAX_RUNNING_JOBS} active jobs`);
  }
  const jobId = `peer-${randomUUID().slice(0, 8)}`;
  const job = {
    jobId,
    status: "running",
    startedAt: new Date().toISOString(),
    result: null,
    client: null,
    cancelRequested: false,
    completionPromise: null,
  };
  jobs.set(jobId, job);
  const client = new AppServerClient(value);
  job.client = client;
  job.completionPromise = runWithTimeout(
    client.run({ task: value.task, threadId }),
    value.timeoutMs,
  )
    .then(async (result) => {
      await client.terminate("Codex peer completed");
      transitionJobToTerminal(job, "completed", { ...result, jobId });
      job.client = null;
      pruneTerminalJobs();
    })
    .catch(async (error) => {
      let terminationError = null;
      try {
        await client.terminate(job.cancelRequested ? "Codex peer cancelled" : "Codex peer stopped");
      } catch (caught) {
        terminationError = caught;
      }
      const status = job.cancelRequested && !terminationError ? "cancelled" : "failed";
      const message = terminationError
        ? `${error.message}; ${terminationError.message}`
        : error.message;
      transitionJobToTerminal(job, status, { jobId, error: message });
      job.client = null;
      pruneTerminalJobs();
    });
  return job;
}

function publicJob(job) {
  return {
    job_id: job.jobId,
    status: job.status,
    started_at: job.startedAt,
    finished_at: job.finishedAt || null,
    thread_id: job.result?.threadId || null,
    error: job.result?.error || null,
  };
}

async function callTool(name, args) {
  if (isNestedPeer) throw new Error(RECURSION_GUARD_MESSAGE);
  if (name === "codex_peer_review") {
    const value = normalizeArgs(args);
    const scope = value.base ? `Review the changes compared with ${value.base}.` : "Review the current uncommitted changes.";
    const focus = value.request ? `\nFocus especially on: ${value.request}` : "";
    const job = startJob({
      ...value,
      allow_writes: false,
      task: `${scope}${focus}\nBe read-only. Report concrete findings with severity, file/line evidence, and suggested fixes.`,
    });
    return formatPeerResult({ ...publicJob(job), status: "started" });
  }
  if (name === "codex_peer_delegate") {
    const job = startJob(args);
    return formatPeerResult({ ...publicJob(job), status: "started" });
  }
  if (name === "codex_peer_follow_up") {
    const job = startJob(args, args?.thread_id);
    return formatPeerResult({ ...publicJob(job), status: "started" });
  }
  if (name === "codex_peer_start") {
    const job = startJob(args);
    return formatPeerResult({ ...publicJob(job), status: "started" });
  }
  if (name === "codex_peer_status") {
    const selected = args?.job_id ? [jobs.get(args.job_id)] : [...jobs.values()].slice(-10).reverse();
    if (selected.some((job) => !job)) throw new Error(`Unknown job: ${args.job_id}`);
    return selected.map(publicJob).map((job) => JSON.stringify(job)).join("\n");
  }
  if (name === "codex_peer_result") {
    const job = jobs.get(args?.job_id);
    if (!job) throw new Error(`Unknown job: ${args?.job_id}`);
    if (job.status === "running" || job.status === "cancelling") {
      return JSON.stringify(publicJob(job));
    }
    return formatPeerResult(job.result || publicJob(job));
  }
  if (name === "codex_peer_cancel") {
    const job = jobs.get(args?.job_id);
    if (!job) throw new Error(`Unknown job: ${args?.job_id}`);
    if (job.status === "running") {
      job.status = "cancelling";
      job.cancelRequested = true;
      try {
        await job.client?.terminate("Codex peer cancelled");
      } catch {
        // The job completion path records termination failures.
      }
      await job.completionPromise;
    } else if (job.status === "cancelling") {
      await job.completionPromise;
    }
    return JSON.stringify(publicJob(job));
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function handleMessage(message) {
  if (message.method === "initialize") {
    const requestedVersion = message.params?.protocolVersion;
    if (typeof requestedVersion !== "string") {
      return jsonRpcError(message.id, -32602, "protocolVersion must be a string");
    }
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
      ? requestedVersion
      : SUPPORTED_PROTOCOL_VERSIONS[0];
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "codex-peer", version: SERVER_VERSION },
      },
    };
  }
  if (message.method === "notifications/initialized") return null;
  if (message.method === "ping") return { jsonrpc: "2.0", id: message.id, result: {} };
  if (message.method === "tools/list") {
    return { jsonrpc: "2.0", id: message.id, result: { tools: isNestedPeer ? [] : tools } };
  }
  if (message.method === "tools/call") {
    let invocation;
    try {
      invocation = validateToolInvocation(message.params);
    } catch (error) {
      return jsonRpcError(message.id, -32602, error.message);
    }
    try {
      const text = await callTool(invocation.name, invocation.args);
      return { jsonrpc: "2.0", id: message.id, result: textResult(text) };
    } catch (error) {
      return { jsonrpc: "2.0", id: message.id, result: textResult(error.message, true) };
    }
  }
  if (message.id === undefined) return null;
  return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
}

const input = createInterface({ input: process.stdin });
input.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const response = await handleMessage(message);
  if (response) writeMessage(response);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const activeJobs = [...jobs.values()].filter(
    (job) => job.status === "running" || job.status === "cancelling",
  );
  for (const job of activeJobs) {
    job.status = "cancelling";
    job.cancelRequested = true;
  }
  await Promise.allSettled(
    activeJobs.map((job) => job.client?.terminate("Codex peer server stopped")),
  );
  await Promise.allSettled(activeJobs.map((job) => job.completionPromise));
  process.exit(0);
}

input.on("close", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
