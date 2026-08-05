import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import {
  readFile,
  readdir,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import test from "node:test";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
const bridgePath = fileURLToPath(new URL("../scripts/claude-peer-mcp.mjs", import.meta.url));
const fakeClaudePath = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const openClients = new Set();

test.after(async () => {
  const cleanupResults = await Promise.allSettled(
    [...openClients].map((client) => client.close()),
  );
  const cleanupErrors = cleanupResults
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Failed to close MCP test clients");
  }
});

class McpTestClient {
  constructor({
    maxOutputBytes = 4096,
    maxSessionHistoryEvents,
    sessionHistoryDir,
  } = {}) {
    this.ownsSessionHistoryDir = !sessionHistoryDir;
    this.sessionHistoryDir =
      sessionHistoryDir || mkdtempSync(join(tmpdir(), "claude-peer-sessions-"));
    this.closePromise = null;
    this.child = spawn(process.execPath, [bridgePath], {
      cwd: pluginRoot,
      env: {
        ...process.env,
        CLAUDE_PEER_CLI: fakeClaudePath,
        CLAUDE_PEER_KILL_GRACE_MS: "50",
        CLAUDE_PEER_MAX_OUTPUT_BYTES: String(maxOutputBytes),
        CLAUDE_PEER_SESSION_HISTORY_DIR: this.sessionHistoryDir,
        ...(maxSessionHistoryEvents
          ? {
              CLAUDE_PEER_MAX_SESSION_HISTORY_EVENTS: String(
                maxSessionHistoryEvents,
              ),
            }
          : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => {
      const message = JSON.parse(line);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.resolve(message);
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    openClients.add(this);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async initialize() {
    return await this.request("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "claude-peer-test", version: "1" },
      capabilities: {},
    });
  }

  async call(name, args = {}) {
    return await this.request("tools/call", { name, arguments: args });
  }

  async close() {
    if (!this.closePromise) {
      this.closePromise = (async () => {
        try {
          let exitCode = this.child.exitCode;
          if (exitCode === null && this.child.signalCode === null) {
            this.child.stdin.end();
            exitCode = await new Promise((resolve) =>
              this.child.once("exit", resolve),
            );
          }
          assert.equal(exitCode, 0, this.stderr);
        } finally {
          openClients.delete(this);
          if (this.ownsSessionHistoryDir) {
            rmSync(this.sessionHistoryDir, { recursive: true, force: true });
          }
        }
      })();
    }
    return await this.closePromise;
  }
}

function resultText(response) {
  return response.result?.content?.[0]?.text || "";
}

function jobId(response) {
  return resultText(response).match(/job_id: (claude-peer-[a-z0-9]+)/)?.[1];
}

async function waitForTerminal(client, id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await client.call("claude_peer_status", { job_id: id });
    const status = JSON.parse(resultText(response));
    if (status.status !== "running") return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`job did not finish: ${id}`);
}

test("auth status is sanitized", async () => {
  const client = new McpTestClient();
  await client.initialize();
  const response = await client.call("claude_peer_auth_status");
  const auth = JSON.parse(resultText(response));
  assert.deepEqual(auth, {
    logged_in: true,
    auth_method: "claude.ai",
    api_provider: "firstParty",
    subscription_type: "max",
  });
  assert.doesNotMatch(resultText(response), /must-not-leak/);
  await client.close();
});

test("review is asynchronous and read-only", async (t) => {
  const client = new McpTestClient();
  t.after(() => client.close());
  await client.initialize();
  const startedAt = Date.now();
  const started = await client.call("claude_peer_review", {
    request: "ECHO_ARGS",
    cwd: testDir,
    effort: "low",
  });
  assert.ok(Date.now() - startedAt < 1000);
  const id = jobId(started);
  assert.ok(id);
  const status = await waitForTerminal(client, id);
  assert.equal(status.status, "completed", status.error);
  const result = await client.call("claude_peer_result", { job_id: id });
  const echoed = JSON.parse(resultText(result).split("\n\n").at(-1));
  assert.ok(echoed.args.includes("plan"));
  assert.ok(echoed.args.includes("--safe-mode"));
  assert.ok(!echoed.args.includes("--setting-sources"));
  assert.ok(echoed.args.includes("Edit,Write,NotebookEdit"));
  assert.deepEqual(
    echoed.args.slice(
      echoed.args.indexOf("--allowedTools") + 1,
      echoed.args.indexOf("--allowedTools") + 5,
    ),
    ["Read", "Glob", "Grep", "Bash"],
  );
  assert.ok(echoed.args.includes("--strict-mcp-config"));
  const settings = JSON.parse(echoed.args[echoed.args.indexOf("--settings") + 1]);
  assert.deepEqual(settings.sandbox.filesystem.denyWrite, ["/"]);
  assert.ok(
    settings.sandbox.filesystem.denyRead.includes(
      client.sessionHistoryDir,
    ),
  );
  assert.ok(
    settings.permissions.deny.some(
      (rule) =>
        rule.startsWith("Read(") &&
        rule.includes(client.sessionHistoryDir),
    ),
  );
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.equal(echoed.subprocessEnvScrub, "1");
  assert.equal(echoed.sessionHistoryDir, null);
  assert.equal(echoed.maxSessionHistoryEvents, null);
  assert.equal(echoed.codexHome, null);
  await client.close();
});

test("writable delegation uses accept-edits with a fail-closed sandbox", async (t) => {
  const client = new McpTestClient();
  t.after(() => client.close());
  await client.initialize();
  const started = await client.call("claude_peer_delegate", {
    task: "ECHO_ARGS",
    allow_writes: true,
    cwd: testDir,
  });
  const id = jobId(started);
  assert.ok(id);
  await waitForTerminal(client, id);
  const result = await client.call("claude_peer_result", { job_id: id });
  const echoed = JSON.parse(resultText(result).split("\n\n").at(-1));
  assert.ok(echoed.args.includes("acceptEdits"));
  assert.equal(
    echoed.args[echoed.args.indexOf("--tools") + 1],
    "Read,Glob,Grep,Bash,Edit,Write,NotebookEdit",
  );
  assert.deepEqual(
    echoed.args.slice(
      echoed.args.indexOf("--allowedTools") + 1,
      echoed.args.indexOf("--allowedTools") + 8,
    ),
    ["Read", "Glob", "Grep", "Bash", "Edit", "Write", "NotebookEdit"],
  );
  assert.ok(echoed.args.includes("--safe-mode"));
  assert.ok(!echoed.args.includes("--setting-sources"));
  const settings = JSON.parse(echoed.args[echoed.args.indexOf("--settings") + 1]);
  assert.equal(settings.sandbox.enabled, true);
  assert.ok(
    settings.sandbox.filesystem.denyRead.includes(
      client.sessionHistoryDir,
    ),
  );
  assert.ok(
    settings.sandbox.filesystem.denyWrite.includes(
      client.sessionHistoryDir,
    ),
  );
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.equal(settings.sandbox.failIfUnavailable, true);
  await client.close();
});

test("usage limit failures report their type and reset time", async () => {
  const client = new McpTestClient();
  await client.initialize();
  const started = await client.call("claude_peer_delegate", {
    task: "USAGE_LIMIT",
    cwd: testDir,
  });
  const id = jobId(started);
  assert.ok(id);
  const status = await waitForTerminal(client, id);
  assert.equal(status.status, "failed");
  assert.equal(status.error_type, "UsageLimit");
  assert.equal(status.unavailable_until, "4:10pm (Asia/Tokyo)");
  assert.equal(
    status.error,
    "Claude Code usage limit reached; unavailable until 4:10pm (Asia/Tokyo).",
  );

  const result = await client.call("claude_peer_result", { job_id: id });
  assert.match(resultText(result), /error_type: UsageLimit/);
  assert.match(resultText(result), /unavailable_until: 4:10pm \(Asia\/Tokyo\)/);
  assert.doesNotMatch(resultText(result), /Permission mode forced/);
  await client.close();
});

test("named subscription limits remain UsageLimit without a reset time", async () => {
  const client = new McpTestClient();
  try {
    await client.initialize();
    for (const task of [
      "FAST_USAGE_LIMIT",
      "MONTHLY_USAGE_LIMIT",
      "MONTHLY_SPEND_USAGE_LIMIT",
      "FABLE_USAGE_LIMIT",
      "WEEKLY_USAGE_LIMIT",
      "OPUS_USAGE_LIMIT",
      "SONNET_USAGE_LIMIT",
    ]) {
      const started = await client.call("claude_peer_delegate", {
        task,
        cwd: testDir,
      });
      const status = await waitForTerminal(client, jobId(started));
      assert.equal(status.status, "failed");
      assert.equal(status.error_type, "UsageLimit");
      assert.equal(status.unavailable_until, null);
      assert.equal(
        status.error,
        "Claude Code usage limit reached; reset time was not provided.",
      );
    }
  } finally {
    await client.close();
  }
});

test("temporary rate limits and empty failures remain generic errors", async () => {
  const client = new McpTestClient();
  try {
    await client.initialize();

    const temporary = await client.call("claude_peer_delegate", {
      task: "TEMPORARY_RATE_LIMIT",
      cwd: testDir,
    });
    const temporaryStatus = await waitForTerminal(client, jobId(temporary));
    assert.equal(temporaryStatus.status, "failed");
    assert.equal(temporaryStatus.error_type, null);
    assert.equal(temporaryStatus.unavailable_until, null);
    assert.equal(
      temporaryStatus.error,
      "Server is temporarily limiting requests (not your usage limit)",
    );

    const empty = await client.call("claude_peer_delegate", {
      task: "EMPTY_FAILURE",
      cwd: testDir,
    });
    const emptyStatus = await waitForTerminal(client, jobId(empty));
    assert.equal(emptyStatus.status, "failed");
    assert.equal(emptyStatus.error, "Claude Code exited (1)");
  } finally {
    await client.close();
  }
});

test("follow-up resumes the returned Claude session", async () => {
  const client = new McpTestClient();
  await client.initialize();
  const first = await client.call("claude_peer_delegate", {
    task: "first",
    cwd: testDir,
  });
  const firstId = jobId(first);
  await waitForTerminal(client, firstId);
  const firstResult = await client.call("claude_peer_result", { job_id: firstId });
  const threadId = resultText(firstResult).match(/thread_id: ([0-9a-f-]+)/)?.[1];
  assert.ok(threadId);

  const followUp = await client.call("claude_peer_follow_up", {
    thread_id: threadId,
    task: "FOLLOW_UP",
    cwd: testDir,
  });
  const followUpId = jobId(followUp);
  await waitForTerminal(client, followUpId);
  const followUpResult = await client.call("claude_peer_result", { job_id: followUpId });
  assert.match(resultText(followUpResult), new RegExp(`thread_id: ${threadId}`));
  assert.match(resultText(followUpResult), /FOLLOW_UP_OK/);
  await client.close();
});

test("session history persists across bridge processes and records follow-ups", async (t) => {
  const sessionHistoryDir = mkdtempSync(join(tmpdir(), "claude-peer-history-"));
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    rmSync(sessionHistoryDir, { recursive: true, force: true });
  });

  const firstClient = new McpTestClient({ sessionHistoryDir });
  clients.push(firstClient);
  await firstClient.initialize();
  const first = await firstClient.call("claude_peer_delegate", {
    task: "first",
    cwd: testDir,
    effort: "low",
  });
  const firstId = jobId(first);
  await waitForTerminal(firstClient, firstId);
  const firstResult = await firstClient.call("claude_peer_result", {
    job_id: firstId,
  });
  const threadId = resultText(firstResult).match(
    /thread_id: ([0-9a-f-]+)/,
  )?.[1];
  assert.ok(threadId);
  await firstClient.close();

  const firstEventNames = await readdir(sessionHistoryDir);
  assert.equal(firstEventNames.length, 1);
  const firstEventPath = join(sessionHistoryDir, firstEventNames[0]);
  const firstEvent = JSON.parse(await readFile(firstEventPath, "utf8"));
  assert.equal(firstEvent.thread_id, threadId);
  assert.equal(firstEvent.job_id, firstId);
  assert.equal(firstEvent.cwd, testDir);
  assert.equal(firstEvent.usage.input_tokens, 10);
  assert.equal(firstEvent.usage.output_tokens, 5);
  assert.equal(firstEvent.total_cost_usd, 0.01);
  if (process.platform !== "win32") {
    assert.equal((await stat(sessionHistoryDir)).mode & 0o777, 0o700);
    assert.equal((await stat(firstEventPath)).mode & 0o777, 0o600);
  }

  const secondClient = new McpTestClient({ sessionHistoryDir });
  clients.push(secondClient);
  await secondClient.initialize();
  const followUp = await secondClient.call("claude_peer_follow_up", {
    thread_id: threadId,
    task: "FOLLOW_UP",
    cwd: testDir,
  });
  const followUpId = jobId(followUp);
  await waitForTerminal(secondClient, followUpId);
  const eventNames = await readdir(sessionHistoryDir);
  assert.equal(eventNames.length, 2);
  const events = await Promise.all(
    eventNames.map(async (name) =>
      JSON.parse(await readFile(join(sessionHistoryDir, name), "utf8")),
    ),
  );
  const followUpEvent = events.find((event) => event.job_id === followUpId);
  assert.equal(followUpEvent.thread_id, threadId);
  assert.equal(followUpEvent.cwd, testDir);
  assert.equal(followUpEvent.usage.input_tokens, 10);
  assert.equal(followUpEvent.usage.output_tokens, 5);
  assert.equal(followUpEvent.total_cost_usd, 0.01);
  await secondClient.close();
});

test("session history stays outside workspaces and has bounded retention", async (t) => {
  const sessionHistoryDir = mkdtempSync(
    join(tmpdir(), "claude-peer-retention-"),
  );
  const workspaceDir = mkdtempSync(join(tmpdir(), "claude-peer-workspace-"));
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    rmSync(sessionHistoryDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  const firstClient = new McpTestClient({
    maxSessionHistoryEvents: 2,
    sessionHistoryDir,
  });
  clients.push(firstClient);
  await firstClient.initialize();
  const first = await firstClient.call("claude_peer_delegate", {
    task: "first",
    cwd: testDir,
  });
  const firstId = jobId(first);
  await waitForTerminal(firstClient, firstId);
  await firstClient.close();

  const concurrentClients = [
    new McpTestClient({
      maxSessionHistoryEvents: 2,
      sessionHistoryDir,
    }),
    new McpTestClient({
      maxSessionHistoryEvents: 2,
      sessionHistoryDir,
    }),
  ];
  clients.push(...concurrentClients);
  await Promise.all(concurrentClients.map((client) => client.initialize()));
  const concurrentJobs = await Promise.all(
    concurrentClients.map((client, index) =>
      client.call("claude_peer_delegate", {
        task: `concurrent-${index}`,
        cwd: testDir,
      }),
    ),
  );
  const concurrentIds = concurrentJobs.map(jobId);
  await Promise.all(
    concurrentClients.map((client, index) =>
      waitForTerminal(client, concurrentIds[index]),
    ),
  );
  await Promise.all(concurrentClients.map((client) => client.close()));

  const retainedEvents = await Promise.all(
    (await readdir(sessionHistoryDir)).map(async (name) =>
      JSON.parse(await readFile(join(sessionHistoryDir, name), "utf8")),
    ),
  );
  assert.equal(retainedEvents.length, 2);
  assert.ok(!retainedEvents.some((event) => event.job_id === firstId));
  assert.deepEqual(
    retainedEvents.map((event) => event.job_id).sort(),
    concurrentIds.sort(),
  );

  const nestedHistoryDir = join(workspaceDir, "history");
  const overlappingClient = new McpTestClient({
    sessionHistoryDir: nestedHistoryDir,
  });
  clients.push(overlappingClient);
  await overlappingClient.initialize();
  const overlapping = await overlappingClient.call("claude_peer_delegate", {
    task: "overlap",
    cwd: workspaceDir,
  });
  const overlappingId = jobId(overlapping);
  await waitForTerminal(overlappingClient, overlappingId);
  const overlappingResult = await overlappingClient.call(
    "claude_peer_result",
    { job_id: overlappingId },
  );
  assert.match(
    resultText(overlappingResult),
    /session history must be outside the delegated workspace/,
  );
  assert.equal(existsSync(nestedHistoryDir), false);
  await overlappingClient.close();
});

test("cancellation waits for an uncooperative worker to be killed", async () => {
  const client = new McpTestClient();
  await client.initialize();
  const started = await client.call("claude_peer_delegate", {
    task: "SLOW_DESCENDANT",
    cwd: testDir,
  });
  const id = jobId(started);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const cancelStartedAt = Date.now();
  const cancelled = await client.call("claude_peer_cancel", { job_id: id });
  assert.ok(Date.now() - cancelStartedAt >= 40);
  assert.equal(JSON.parse(resultText(cancelled)).status, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const status = await client.call("claude_peer_status", { job_id: id });
  assert.equal(JSON.parse(resultText(status)).status, "cancelled");
  await client.close();
});

test("output overflow fails one job without crashing the bridge", async () => {
  const client = new McpTestClient({ maxOutputBytes: 1024 });
  await client.initialize();
  const started = await client.call("claude_peer_delegate", {
    task: "HUGE",
    cwd: testDir,
  });
  const id = jobId(started);
  assert.equal((await waitForTerminal(client, id)).status, "failed");
  const result = await client.call("claude_peer_result", { job_id: id });
  assert.match(resultText(result), /output exceeded 1024 bytes/);

  const auth = await client.call("claude_peer_auth_status");
  assert.equal(JSON.parse(resultText(auth)).logged_in, true);
  await client.close();
});

test("running jobs and task size are bounded", async () => {
  const client = new McpTestClient();
  await client.initialize();
  const ids = [];
  for (let index = 0; index < 4; index += 1) {
    const started = await client.call("claude_peer_delegate", {
      task: "SLOW",
      cwd: testDir,
    });
    ids.push(jobId(started));
  }
  const overflow = await client.call("claude_peer_delegate", {
    task: "SLOW",
    cwd: testDir,
  });
  assert.equal(overflow.result?.isError, true);
  assert.match(resultText(overflow), /4 active jobs/);
  for (const id of ids) await client.call("claude_peer_cancel", { job_id: id });

  const oversized = await client.call("claude_peer_delegate", {
    task: "x".repeat(256 * 1024 + 1),
    cwd: testDir,
  });
  assert.equal(oversized.result?.isError, true);
  assert.match(resultText(oversized), /task exceeds/);
  await client.close();
});

test("protocol versions are negotiated and malformed tool calls are protocol errors", async () => {
  const client = new McpTestClient();
  const initialized = await client.request("initialize", {
    protocolVersion: "2099-01-01",
    clientInfo: { name: "future-client", version: "1" },
    capabilities: {},
  });
  assert.equal(initialized.result.protocolVersion, "2025-06-18");
  const unknown = await client.call("not_a_tool");
  assert.equal(unknown.error?.code, -32602);
  assert.match(unknown.error?.message, /Unknown tool/);
  const malformed = await client.request("tools/call", {
    name: "claude_peer_delegate",
    arguments: {},
  });
  assert.equal(malformed.error?.code, -32602);
  assert.match(malformed.error?.message, /Missing required argument/);
  await client.close();
});

test("packaged MCP configuration launches the package-relative bridge", async () => {
  const config = JSON.parse(await readFile(new URL("../.mcp.json", import.meta.url), "utf8"));
  const server = config.mcpServers.claude_peer;
  assert.equal(server.command, "node");
  assert.equal(server.args[0], "./scripts/claude-peer-mcp.mjs");
  assert.equal(server.cwd, ".");
  const resolvedCwd = isAbsolute(server.cwd) ? server.cwd : resolve(pluginRoot, server.cwd);

  const child = spawn(server.command, server.args, {
    cwd: resolvedCwd,
    env: {
      ...process.env,
      CLAUDE_PEER_CLI: fakeClaudePath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const response = new Promise((resolve) => lines.once("line", (line) => resolve(JSON.parse(line))));
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "package-test", version: "1" },
        capabilities: {},
      },
    })}\n`,
  );
  assert.equal((await response).result.protocolVersion, "2024-11-05");
  child.stdin.end();
  assert.equal(await new Promise((resolve) => child.once("exit", resolve)), 0);
});

test("terminal job retention is bounded by completion order", async () => {
  const client = new McpTestClient();
  await client.initialize();
  const ids = [];
  for (let index = 0; index < 51; index += 1) {
    const started = await client.call("claude_peer_delegate", {
      task: "FAIL",
      cwd: testDir,
    });
    const id = jobId(started);
    ids.push(id);
    await waitForTerminal(client, id);
  }
  const oldest = await client.call("claude_peer_status", { job_id: ids[0] });
  assert.equal(oldest.result?.isError, true);
  assert.match(resultText(oldest), /Unknown job/);
  const newest = await client.call("claude_peer_status", { job_id: ids.at(-1) });
  assert.equal(JSON.parse(resultText(newest)).status, "failed");
  await client.close();
});
