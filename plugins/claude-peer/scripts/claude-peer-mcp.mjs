#!/usr/bin/env node

import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { createInterface } from "node:readline";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SERVER_VERSION = "0.1.0";
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const HARD_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const parsedMaxOutputBytes = Number.parseInt(
  process.env.CLAUDE_PEER_MAX_OUTPUT_BYTES || String(HARD_MAX_OUTPUT_BYTES),
  10,
);
const MAX_OUTPUT_BYTES =
  Number.isInteger(parsedMaxOutputBytes) && parsedMaxOutputBytes >= 1024
    ? Math.min(parsedMaxOutputBytes, HARD_MAX_OUTPUT_BYTES)
    : HARD_MAX_OUTPUT_BYTES;
const MAX_TASK_BYTES = 256 * 1024;
const MAX_RUNNING_JOBS = 4;
const MAX_RETAINED_TERMINAL_JOBS = 50;
const HARD_MAX_RETAINED_SESSION_EVENTS = 1000;
const parsedMaxRetainedSessionEvents = Number.parseInt(
  process.env.CLAUDE_PEER_MAX_SESSION_HISTORY_EVENTS ||
    String(HARD_MAX_RETAINED_SESSION_EVENTS),
  10,
);
const MAX_RETAINED_SESSION_EVENTS =
  Number.isInteger(parsedMaxRetainedSessionEvents) &&
  parsedMaxRetainedSessionEvents >= 1
    ? Math.min(
        parsedMaxRetainedSessionEvents,
        HARD_MAX_RETAINED_SESSION_EVENTS,
      )
    : HARD_MAX_RETAINED_SESSION_EVENTS;
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const PEER_DEPTH_ENV = "CLAUDE_PEER_DEPTH";
const SIBLING_PEER_DEPTH_ENV = "CODEX_PEER_DEPTH";
const CLAUDE_CLI = process.env.CLAUDE_PEER_CLI || "claude";
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const SESSION_HISTORY_OVERRIDE =
  process.env.CLAUDE_PEER_SESSION_HISTORY_DIR || null;
const SESSION_HISTORY_CONFIG_ERROR =
  SESSION_HISTORY_OVERRIDE && !isAbsolute(SESSION_HISTORY_OVERRIDE)
    ? "CLAUDE_PEER_SESSION_HISTORY_DIR must be an absolute path"
    : null;
const SESSION_HISTORY_DIR = resolve(
  SESSION_HISTORY_OVERRIDE ||
    join(CODEX_HOME, "state", "claude-peer", "sessions"),
);
const parsedKillGraceMs = Number.parseInt(process.env.CLAUDE_PEER_KILL_GRACE_MS || "2000", 10);
const KILL_GRACE_MS =
  Number.isInteger(parsedKillGraceMs) && parsedKillGraceMs >= 10
    ? Math.min(parsedKillGraceMs, 10000)
    : 2000;
const parsedPeerDepth = Number.parseInt(process.env[PEER_DEPTH_ENV] || "0", 10);
const peerDepth = Number.isInteger(parsedPeerDepth) && parsedPeerDepth >= 0 ? parsedPeerDepth : 0;
const parsedSiblingPeerDepth = Number.parseInt(process.env[SIBLING_PEER_DEPTH_ENV] || "0", 10);
const siblingPeerDepth =
  Number.isInteger(parsedSiblingPeerDepth) && parsedSiblingPeerDepth >= 0 ? parsedSiblingPeerDepth : 0;
const isNestedPeer = peerDepth > 0 || siblingPeerDepth > 0;
const RECURSION_GUARD_MESSAGE = `claude-peer is disabled inside nested peer sessions (claude depth ${peerDepth}, codex depth ${siblingPeerDepth})`;
const DELEGATED_JOB_NOTICE =
  "\n\n[peer-delegated job] This session is a delegated peer job. Never invoke codex_peer or claude_peer tools in this session, even if globally loaded instructions (such as AGENTS.md review gates) call for peer reviews, and even if this session is later resumed interactively. If additional peer review seems necessary, state that in your final report instead of starting one.";

// Delegated-thread registry shared with codex-peer: peer-spawned session IDs
// are recorded so that a bridge can refuse peer tools when its host session is
// a delegated thread that was later resumed interactively (env-based depth
// guards do not survive `codex resume` / `claude --resume`, which start fresh
// processes without the depth markers).
const DELEGATED_THREADS_REGISTRY = join(
  CODEX_HOME,
  "state",
  "peer-delegated-threads.jsonl",
);
const DELEGATED_THREADS_MAX_LINES = 1000;
const RESUMED_DELEGATION_GUARD_MESSAGE =
  "claude-peer is disabled in this session: the host thread was started as a peer-delegated job. Resumed delegated sessions must not start peer jobs; report the need for review to the user instead.";

function registerDelegatedThread(threadId) {
  if (typeof threadId !== "string" || threadId.trim() === "") return;
  try {
    mkdirSync(dirname(DELEGATED_THREADS_REGISTRY), { recursive: true });
    let lines = [];
    if (existsSync(DELEGATED_THREADS_REGISTRY)) {
      lines = readFileSync(DELEGATED_THREADS_REGISTRY, "utf8").split("\n").filter(Boolean);
    }
    if (lines.includes(threadId)) return;
    lines.push(threadId);
    if (lines.length > DELEGATED_THREADS_MAX_LINES) {
      lines = lines.slice(-DELEGATED_THREADS_MAX_LINES);
    }
    writeFileSync(DELEGATED_THREADS_REGISTRY, `${lines.join("\n")}\n`);
  } catch {
    // Best-effort: the registry is a defense-in-depth layer, not a hard dependency.
  }
}

function delegatedThreadIds() {
  try {
    if (!existsSync(DELEGATED_THREADS_REGISTRY)) return new Set();
    return new Set(
      readFileSync(DELEGATED_THREADS_REGISTRY, "utf8").split("\n").filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

function peerProcessField(pid, field) {
  try {
    return execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function hostRolloutThreadId() {
  let pid = process.ppid;
  for (let level = 0; level < 32 && pid > 1; level += 1) {
    let openFiles = "";
    try {
      openFiles = execFileSync("lsof", ["-p", String(pid), "-Fn"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      openFiles = "";
    }
    const codexMatch = openFiles.match(
      /rollout-[0-9T-]+-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl/,
    );
    if (codexMatch) return codexMatch[1];
    const claudeMatch = openFiles.match(
      /\.claude\/projects\/[^\n]*\/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl/,
    );
    if (claudeMatch) return claudeMatch[1];
    const parentPid = Number.parseInt(peerProcessField(pid, "ppid"), 10);
    if (!Number.isInteger(parentPid) || parentPid <= 0 || parentPid === pid) return null;
    pid = parentPid;
  }
  return null;
}

function assertHostNotDelegatedThread() {
  const hostThreadId = hostRolloutThreadId();
  if (hostThreadId && delegatedThreadIds().has(hostThreadId)) {
    throw new Error(RESUMED_DELEGATION_GUARD_MESSAGE);
  }
}

const jobs = new Map();
let nextCompletionSequence = 1;

function resolveFromExistingAncestor(targetPath) {
  let currentPath = resolve(targetPath);
  const missingSegments = [];
  while (!existsSync(currentPath)) {
    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) return resolve(targetPath);
    missingSegments.unshift(basename(currentPath));
    currentPath = parentPath;
  }
  return resolve(realpathSync(currentPath), ...missingSegments);
}

function toClaudePermissionPath(targetPath) {
  let normalized = resolve(targetPath).replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    normalized = `/${normalized[0].toLowerCase()}${normalized.slice(2)}`;
  }
  return `/${normalized.replace(/\/+$/, "")}/**`;
}

const SESSION_HISTORY_DENY_PATHS = [
  ...new Set([
    SESSION_HISTORY_DIR,
    resolveFromExistingAncestor(SESSION_HISTORY_DIR),
  ]),
];
const SESSION_HISTORY_DENY_RULES = SESSION_HISTORY_DENY_PATHS.flatMap(
  (targetPath) => {
    const pattern = toClaudePermissionPath(targetPath);
    return [`Read(${pattern})`, `Edit(${pattern})`];
  },
);

const BASE_SANDBOX_SETTINGS = {
  permissions: {
    deny: SESSION_HISTORY_DENY_RULES,
  },
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    failIfUnavailable: true,
    filesystem: {
      denyRead: SESSION_HISTORY_DENY_PATHS,
      denyWrite: SESSION_HISTORY_DENY_PATHS,
    },
  },
};

const READ_ONLY_SANDBOX_SETTINGS = JSON.stringify({
  ...BASE_SANDBOX_SETTINGS,
  sandbox: {
    ...BASE_SANDBOX_SETTINGS.sandbox,
    filesystem: {
      ...BASE_SANDBOX_SETTINGS.sandbox.filesystem,
      denyWrite: ["/"],
    },
  },
});

const WRITE_SANDBOX_SETTINGS = JSON.stringify(BASE_SANDBOX_SETTINGS);

const EMPTY_MCP_CONFIG = JSON.stringify({ mcpServers: {} });

const tools = [
  {
    name: "claude_peer_auth_status",
    description:
      "Return a sanitized Claude Code authentication status without account identifiers or credentials.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "claude_peer_review",
    description:
      "Start a read-only Claude Code review and immediately return a job ID. Poll with claude_peer_status, then collect the result with claude_peer_result.",
    inputSchema: {
      type: "object",
      properties: {
        request: { type: "string", description: "Optional review focus or question." },
        base: { type: "string", description: "Optional branch or ref to compare against." },
        cwd: { type: "string", description: "Workspace path. Defaults to the current workspace." },
        model: { type: "string", description: "Optional Claude model override." },
        effort: { type: "string", description: "Optional Claude effort override." },
        timeout_seconds: { type: "integer", minimum: 30, maximum: 7200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "claude_peer_delegate",
    description:
      "Start a Claude Code task and immediately return a job ID. Poll with claude_peer_status, then collect the result with claude_peer_result. Defaults to read-only; set allow_writes=true only when the user explicitly authorizes edits.",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: { type: "string", description: "Task for the Claude Code session." },
        allow_writes: { type: "boolean", description: "Allow edits in the workspace; default false." },
        cwd: { type: "string", description: "Workspace path. Defaults to the current workspace." },
        model: { type: "string", description: "Optional Claude model override." },
        effort: { type: "string", description: "Optional Claude effort override." },
        timeout_seconds: { type: "integer", minimum: 30, maximum: 7200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "claude_peer_follow_up",
    description:
      "Continue an existing Claude Code session in the background and immediately return a job ID. Poll with claude_peer_status, then collect the result with claude_peer_result.",
    inputSchema: {
      type: "object",
      required: ["thread_id", "task"],
      properties: {
        thread_id: { type: "string" },
        task: { type: "string" },
        allow_writes: { type: "boolean", description: "Allow edits in the workspace; default false." },
        cwd: { type: "string", description: "Workspace path. Defaults to the current workspace." },
        model: { type: "string", description: "Optional Claude model override." },
        effort: { type: "string", description: "Optional Claude effort override." },
        timeout_seconds: { type: "integer", minimum: 30, maximum: 7200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "claude_peer_start",
    description:
      "Start an explicitly constructed Claude Code background task and return a job ID.",
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
    name: "claude_peer_status",
    description:
      "Show the state of a Claude Peer background job, or the latest few jobs when no job ID is supplied.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "claude_peer_result",
    description: "Return the stored final result of a completed Claude Peer background job.",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: { job_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "claude_peer_cancel",
    description: "Cancel a running Claude Peer background job.",
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
  if (result.errorType) parts.push(`error_type: ${result.errorType}`);
  if (result.unavailableUntil) {
    parts.push(`unavailable_until: ${result.unavailableUntil}`);
  }
  if (result.error) parts.push(`error: ${result.error}`);
  if (result.historyWarning) {
    parts.push(`session_history_warning: ${result.historyWarning}`);
  }
  if (Array.isArray(result.permissionDenials) && result.permissionDenials.length > 0) {
    parts.push(`permission_denials: ${JSON.stringify(result.permissionDenials)}`);
  }
  return parts.join("\n\n") || "Claude peer returned no output.";
}

function sanitizeUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const sanitized = {};
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      sanitized[key] = value;
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function isPathWithin(parentPath, candidatePath) {
  const pathFromParent = relative(parentPath, candidatePath);
  return (
    pathFromParent === "" ||
    (pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent))
  );
}

function pathsOverlap(leftPath, rightPath) {
  return (
    isPathWithin(leftPath, rightPath) ||
    isPathWithin(rightPath, leftPath)
  );
}

function pruneSessionEvents(historyRoot) {
  const eventNames = readdirSync(historyRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i.test(
          entry.name,
        ),
    )
    .map((entry) => entry.name)
    .sort();
  const excess = eventNames.length - MAX_RETAINED_SESSION_EVENTS;
  for (let index = 0; index < excess; index += 1) {
    try {
      unlinkSync(join(historyRoot, eventNames[index]));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function writeSessionEvent(job) {
  const result = job.result;
  if (!result?.threadId) return;
  if (SESSION_HISTORY_CONFIG_ERROR) {
    throw new Error(SESSION_HISTORY_CONFIG_ERROR);
  }

  const workspacePath = realpathSync(resolve(job.cwd));
  const predictedHistoryPath =
    resolveFromExistingAncestor(SESSION_HISTORY_DIR);
  if (
    pathsOverlap(resolve(job.cwd), SESSION_HISTORY_DIR) ||
    pathsOverlap(workspacePath, predictedHistoryPath)
  ) {
    throw new Error(
      "Claude Peer session history must be outside the delegated workspace",
    );
  }

  mkdirSync(SESSION_HISTORY_DIR, { recursive: true, mode: 0o700 });
  chmodSync(SESSION_HISTORY_DIR, 0o700);
  const historyRoot = realpathSync(SESSION_HISTORY_DIR);
  if (pathsOverlap(workspacePath, historyRoot)) {
    throw new Error(
      "Claude Peer session history must be outside the delegated workspace",
    );
  }
  const event = {
    version: 1,
    thread_id: result.threadId,
    job_id: job.jobId,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
    cwd: job.cwd,
    allow_writes: job.allowWrites,
    model: job.model,
    effort: job.effort,
    duration_ms: result.durationMs ?? null,
    num_turns: result.numTurns ?? null,
    usage: sanitizeUsage(result.usage),
    total_cost_usd: result.totalCostUsd ?? null,
  };
  const eventName = `${Date.now()}-${randomUUID()}.json`;
  const eventPath = join(historyRoot, eventName);
  const temporaryPath = join(
    historyRoot,
    `.${eventName}.${process.pid}.tmp`,
  );
  writeFileSync(temporaryPath, `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporaryPath, eventPath);
  pruneSessionEvents(historyRoot);
}

function validateCwd(cwd) {
  let stat;
  try {
    stat = statSync(cwd);
  } catch (error) {
    throw new Error(`Workspace is not accessible: ${cwd} (${error.message})`);
  }
  if (!stat.isDirectory()) throw new Error(`Workspace is not a directory: ${cwd}`);
}

function parseClaudeJson(stdout) {
  const value = stdout.trim();
  if (!value) throw new Error("Claude Code returned no JSON output");
  try {
    return JSON.parse(value);
  } catch {
    const lines = value.split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]);
      } catch {
        // Keep looking for the final JSON result line.
      }
    }
  }
  throw new Error("Claude Code returned invalid JSON output");
}

class ClaudeUsageLimitError extends Error {
  constructor(unavailableUntil) {
    super(
      unavailableUntil
        ? `Claude Code usage limit reached; unavailable until ${unavailableUntil}.`
        : "Claude Code usage limit reached; reset time was not provided.",
    );
    this.name = "UsageLimit";
    this.unavailableUntil = unavailableUntil;
  }
}

function errorText(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => errorText(item))
      .filter(Boolean)
      .join(" ");
  }
  if (!value || typeof value !== "object") return "";
  return [value.message, value.text, value.detail, value.error, value.content]
    .map((item) => errorText(item))
    .filter(Boolean)
    .join(" ");
}

function claudeFailureFromPayload(payload) {
  const detailParts = [
    errorText(payload.result),
    errorText(payload.errors),
    errorText(payload.error),
    errorText(payload.message),
  ].filter(Boolean);
  const details = detailParts.join(" ");
  const status = Number(
    payload.api_error_status ??
      payload.status_code ??
      payload.error?.status ??
      payload.error?.status_code,
  );
  const explicitlyNotUsageLimit = /\bnot (?:your )?usage limit\b/i.test(details);
  const isUsageLimit =
    !explicitlyNotUsageLimit &&
    (/\byou(?:['’]ve| have) (?:hit|reached) your (?:[a-z0-9][a-z0-9 -]{0,63} )?limit\b/i.test(
      details,
    ) ||
      /\b(?:session|usage) limit (?:has been )?(?:reached|exceeded)\b/i.test(details) ||
      ((status === 429 || payload.error === "rate_limit") &&
        /\bresets?(?:\s+at)?\s+/i.test(details)));
  if (isUsageLimit) {
    const resetText = detailParts.find((part) => /\bresets?(?:\s+at)?\s+/i.test(part)) || "";
    const resetMatch = resetText.match(/\bresets?(?:\s+at)?\s+([^\r\n]+)/i);
    const unavailableUntil = resetMatch?.[1]?.trim().replace(/[.!?]+$/, "") || null;
    throw new ClaudeUsageLimitError(unavailableUntil);
  }
  throw new Error(detailParts[0] || String(payload.api_error_status || "Claude Code task failed"));
}

class ClaudeProcessClient {
  constructor({ cwd, allowWrites, model, effort }) {
    this.cwd = cwd;
    this.allowWrites = allowWrites;
    this.model = model;
    this.effort = effort;
    this.child = null;
    this.processGroupId = null;
    this.stopReason = null;
    this.terminationPromise = null;
  }

  buildArgs(sessionId) {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      this.allowWrites ? "acceptEdits" : "plan",
      "--safe-mode",
      "--mcp-config",
      EMPTY_MCP_CONFIG,
      "--strict-mcp-config",
      "--no-chrome",
      "--prompt-suggestions",
      "false",
    ];
    args.push(
      "--settings",
      this.allowWrites ? WRITE_SANDBOX_SETTINGS : READ_ONLY_SANDBOX_SETTINGS,
    );
    if (this.allowWrites) {
      args.push("--tools", "Read,Glob,Grep,Bash,Edit,Write,NotebookEdit");
      args.push(
        "--allowedTools",
        "Read",
        "Glob",
        "Grep",
        "Bash",
        "Edit",
        "Write",
        "NotebookEdit",
      );
    } else {
      args.push("--tools", "Read,Glob,Grep,Bash");
      args.push("--allowedTools", "Read", "Glob", "Grep", "Bash");
      args.push("--disallowedTools", "Edit,Write,NotebookEdit");
    }
    if (this.model) args.push("--model", String(this.model));
    if (this.effort) args.push("--effort", String(this.effort));
    if (sessionId) args.push("--resume", sessionId);
    return args;
  }

  run({ task, threadId }) {
    return new Promise((resolve, reject) => {
      const args = this.buildArgs(threadId);
      const childEnvironment = {
        ...process.env,
        [PEER_DEPTH_ENV]: String(peerDepth + 1),
        CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      };
      delete childEnvironment.CLAUDE_PEER_SESSION_HISTORY_DIR;
      delete childEnvironment.CLAUDE_PEER_MAX_SESSION_HISTORY_EVENTS;
      delete childEnvironment.CODEX_HOME;
      const child = spawn(CLAUDE_CLI, args, {
        cwd: this.cwd,
        env: childEnvironment,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      this.processGroupId = process.platform === "win32" ? null : child.pid;
      const stdoutChunks = [];
      let stdoutBytes = 0;
      let stderrText = "";
      let settled = false;
      const resolveOnce = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const rejectOnce = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      child.stdout.on("data", (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_OUTPUT_BYTES) {
          child.stdout.pause();
          void this.terminate(`Claude peer output exceeded ${MAX_OUTPUT_BYTES} bytes`).catch(() => {});
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderrText = `${stderrText}${chunk}`.slice(-8000);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(task);
      child.once("error", (error) => rejectOnce(error));
      child.once("close", (code, signal) => {
        if (this.stopReason) {
          rejectOnce(new Error(this.stopReason));
          return;
        }
        const stdoutText = Buffer.concat(stdoutChunks).toString("utf8");
        if (code !== 0) {
          let payload = null;
          try {
            payload = parseClaudeJson(stdoutText);
          } catch {
            // Non-JSON failures fall back to stderr or the process exit status.
          }
          if (payload && typeof payload === "object") {
            try {
              claudeFailureFromPayload(payload);
            } catch (error) {
              if (error instanceof ClaudeUsageLimitError) {
                rejectOnce(error);
                return;
              }
              rejectOnce(
                new Error(
                  error.message ||
                    stderrText.trim() ||
                    `Claude Code exited (${code ?? "unknown"}${signal ? `, ${signal}` : ""})`,
                ),
              );
              return;
            }
          }
          rejectOnce(
            new Error(
              stderrText.trim() ||
                `Claude Code exited (${code ?? "unknown"}${signal ? `, ${signal}` : ""})`,
            ),
          );
          return;
        }
        try {
          const payload = parseClaudeJson(stdoutText);
          if (payload.is_error === true || payload.subtype === "error") {
            claudeFailureFromPayload(payload);
          }
          if (typeof payload.session_id !== "string" || payload.session_id.length === 0) {
            throw new Error("Claude Code result did not include a session ID");
          }
          registerDelegatedThread(payload.session_id);
          resolveOnce({
            status: "completed",
            text: typeof payload.result === "string" ? payload.result : "",
            threadId: payload.session_id,
            permissionDenials: payload.permission_denials,
            durationMs: payload.duration_ms,
            numTurns: payload.num_turns,
            usage: sanitizeUsage(payload.usage),
            totalCostUsd:
              typeof payload.total_cost_usd === "number" &&
              Number.isFinite(payload.total_cost_usd)
                ? payload.total_cost_usd
                : null,
          });
        } catch (error) {
          rejectOnce(error);
        }
      });
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

  terminate(reason = "Claude peer stopped") {
    this.stopReason = this.stopReason || reason;
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
            finish(new Error("Claude peer process group survived SIGKILL"));
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
      () => reject(new Error(`Claude peer timed out after ${Math.round(timeoutMs / 1000)} seconds`)),
      Math.min(timeoutMs, MAX_TIMEOUT_MS),
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
  if (status === "completed") {
    try {
      writeSessionEvent(job);
    } catch (error) {
      job.result = { ...result, historyWarning: error.message };
    }
  }
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
    throw new Error(`Claude peer already has ${MAX_RUNNING_JOBS} active jobs`);
  }
  validateCwd(value.cwd);
  const jobId = `claude-peer-${randomUUID().slice(0, 8)}`;
  const job = {
    jobId,
    status: "running",
    startedAt: new Date().toISOString(),
    cwd: value.cwd,
    allowWrites: value.allowWrites,
    model: value.model ?? null,
    effort: value.effort ?? null,
    result: null,
    client: null,
    cancelRequested: false,
    completionPromise: null,
  };
  jobs.set(jobId, job);
  const client = new ClaudeProcessClient(value);
  job.client = client;
  job.completionPromise = runWithTimeout(
    client.run({ task: value.task + DELEGATED_JOB_NOTICE, threadId }),
    value.timeoutMs,
  )
    .then((result) => {
      transitionJobToTerminal(job, "completed", { ...result, jobId });
      job.client = null;
      pruneTerminalJobs();
    })
    .catch(async (error) => {
      let terminationError = null;
      try {
        await client.terminate(
          job.cancelRequested ? "Claude peer cancelled" : "Claude peer stopped",
        );
      } catch (caught) {
        terminationError = caught;
      }
      const status = job.cancelRequested && !terminationError ? "cancelled" : "failed";
      const message = terminationError
        ? `${error.message}; ${terminationError.message}`
        : error.message;
      transitionJobToTerminal(job, status, {
        jobId,
        error: message,
        errorType: error instanceof ClaudeUsageLimitError ? error.name : null,
        unavailableUntil:
          error instanceof ClaudeUsageLimitError ? error.unavailableUntil : null,
      });
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
    error_type: job.result?.errorType || null,
    unavailable_until: job.result?.unavailableUntil || null,
  };
}

async function sanitizedAuthStatus() {
  const { stdout } = await execFileAsync(CLAUDE_CLI, ["auth", "status", "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      [PEER_DEPTH_ENV]: String(peerDepth + 1),
    },
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  const payload = parseClaudeJson(stdout);
  return JSON.stringify({
    logged_in: payload.loggedIn === true,
    auth_method: typeof payload.authMethod === "string" ? payload.authMethod : null,
    api_provider: typeof payload.apiProvider === "string" ? payload.apiProvider : null,
    subscription_type:
      typeof payload.subscriptionType === "string" ? payload.subscriptionType : null,
  });
}

const PEER_ACTION_TOOLS = new Set([
  "claude_peer_review",
  "claude_peer_delegate",
  "claude_peer_follow_up",
]);

async function callTool(name, args) {
  if (isNestedPeer) throw new Error(RECURSION_GUARD_MESSAGE);
  if (PEER_ACTION_TOOLS.has(name)) assertHostNotDelegatedThread();
  if (name === "claude_peer_auth_status") return await sanitizedAuthStatus();
  if (name === "claude_peer_review") {
    const value = normalizeArgs(args);
    const scope = value.base
      ? `Review the changes compared with ${value.base}.`
      : "Review the current uncommitted changes.";
    const focus = value.request ? `\nFocus especially on: ${value.request}` : "";
    const job = startJob({
      ...value,
      allow_writes: false,
      task: `${scope}${focus}\nBe read-only. Report only reproducible P0-P2 findings with severity, exact file/line evidence, the triggering scenario, impact, and a concrete fix. If there are no findings, say No findings. State validation ceilings separately. Review the code and diff statically: do not run test suites, builds, linters, deploys, package installs, or other CI-equivalent commands; validation is the delegating agent's responsibility. If the diff includes user-facing copy (labels, messages, emails), also review it for spec-notation leakage (e.g. pipe/slash-delimited alternatives), internal jargon or key names surfacing in UI text, and terminology inconsistency with existing copy.`,
    });
    return formatPeerResult({ ...publicJob(job), status: "started" });
  }
  if (name === "claude_peer_delegate") {
    const job = startJob(args);
    return formatPeerResult({ ...publicJob(job), status: "started" });
  }
  if (name === "claude_peer_follow_up") {
    const job = startJob(args, args?.thread_id);
    return formatPeerResult({ ...publicJob(job), status: "started" });
  }
  if (name === "claude_peer_start") {
    const job = startJob(args);
    return formatPeerResult({ ...publicJob(job), status: "started" });
  }
  if (name === "claude_peer_status") {
    const selected = args?.job_id ? [jobs.get(args.job_id)] : [...jobs.values()].slice(-10).reverse();
    if (selected.some((job) => !job)) throw new Error(`Unknown job: ${args.job_id}`);
    return selected.map(publicJob).map((job) => JSON.stringify(job)).join("\n");
  }
  if (name === "claude_peer_result") {
    const job = jobs.get(args?.job_id);
    if (!job) throw new Error(`Unknown job: ${args?.job_id}`);
    if (job.status === "running" || job.status === "cancelling") {
      return JSON.stringify(publicJob(job));
    }
    return formatPeerResult(job.result || publicJob(job));
  }
  if (name === "claude_peer_cancel") {
    const job = jobs.get(args?.job_id);
    if (!job) throw new Error(`Unknown job: ${args?.job_id}`);
    if (job.status === "running") {
      job.status = "cancelling";
      job.cancelRequested = true;
      try {
        await job.client?.terminate("Claude peer cancelled");
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
        serverInfo: { name: "claude-peer", version: SERVER_VERSION },
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
  return {
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `Method not found: ${message.method}` },
  };
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
    activeJobs.map((job) => job.client?.terminate("Claude peer server stopped")),
  );
  await Promise.allSettled(activeJobs.map((job) => job.completionPromise));
  process.exit(0);
}

input.on("close", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
