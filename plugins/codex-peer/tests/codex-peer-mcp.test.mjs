import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
const bridgePath = fileURLToPath(new URL("../scripts/codex-peer-mcp.mjs", import.meta.url));
const fakeCodexPath = fileURLToPath(new URL("./fake-codex.mjs", import.meta.url));

class McpTestClient {
  constructor() {
    this.child = spawn(process.execPath, [bridgePath], {
      cwd: pluginRoot,
      env: {
        ...process.env,
        CODEX_PEER_CLI: fakeCodexPath,
        CODEX_PEER_KILL_GRACE_MS: "50",
        CODEX_PEER_MAX_OUTPUT_BYTES: "1024",
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
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async initialize() {
    return await this.request("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "codex-peer-test", version: "1" },
      capabilities: {},
    });
  }

  async call(name, args = {}) {
    return await this.request("tools/call", { name, arguments: args });
  }

  async close() {
    this.child.stdin.end();
    const exitCode = await new Promise((resolve) => this.child.once("exit", resolve));
    assert.equal(exitCode, 0, this.stderr);
  }
}

function resultText(response) {
  return response.result?.content?.[0]?.text || "";
}

function jobId(response) {
  return resultText(response).match(/job_id: (peer-[a-z0-9]+)/)?.[1];
}

async function waitForTerminal(client, id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await client.call("codex_peer_status", { job_id: id });
    const status = JSON.parse(resultText(response));
    if (status.status !== "running" && status.status !== "cancelling") return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`job did not finish: ${id}`);
}

test("read-only and writable jobs use the requested sandbox policy", async () => {
  const client = new McpTestClient();
  await client.initialize();
  for (const allowWrites of [false, true]) {
    const started = await client.call("codex_peer_delegate", {
      task: "ECHO_CONFIG",
      allow_writes: allowWrites,
      cwd: testDir,
    });
    const id = jobId(started);
    assert.ok(id);
    assert.equal((await waitForTerminal(client, id)).status, "completed");
    const result = await client.call("codex_peer_result", { job_id: id });
    const config = JSON.parse(resultText(result).split("\n\n").at(-1));
    assert.equal(config.approvalPolicy, "never");
    assert.equal(config.sandboxPolicy.type, allowWrites ? "workspaceWrite" : "readOnly");
  }
  await client.close();
});

test("follow-up resumes the returned Codex thread", async () => {
  const client = new McpTestClient();
  await client.initialize();
  const first = await client.call("codex_peer_delegate", {
    task: "first",
    cwd: testDir,
  });
  const firstId = jobId(first);
  await waitForTerminal(client, firstId);
  const firstResult = await client.call("codex_peer_result", { job_id: firstId });
  const threadId = resultText(firstResult).match(/thread_id: ([0-9a-f-]+)/)?.[1];
  assert.ok(threadId);

  const followUp = await client.call("codex_peer_follow_up", {
    thread_id: threadId,
    task: "FOLLOW_UP",
    cwd: testDir,
  });
  const followUpId = jobId(followUp);
  await waitForTerminal(client, followUpId);
  const followUpResult = await client.call("codex_peer_result", { job_id: followUpId });
  assert.match(resultText(followUpResult), new RegExp(`thread_id: ${threadId}`));
  assert.match(resultText(followUpResult), /FOLLOW_UP_OK/);
  await client.close();
});

test("cancellation waits for an uncooperative worker to be killed", async () => {
  const client = new McpTestClient();
  await client.initialize();
  const started = await client.call("codex_peer_delegate", {
    task: "SLOW_DESCENDANT",
    cwd: testDir,
  });
  const id = jobId(started);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const cancelStartedAt = Date.now();
  const cancelled = await client.call("codex_peer_cancel", { job_id: id });
  assert.ok(Date.now() - cancelStartedAt >= 40);
  assert.equal(JSON.parse(resultText(cancelled)).status, "cancelled");
  await client.close();
});

test("running jobs, task input, and output are bounded", async () => {
  const client = new McpTestClient();
  await client.initialize();
  const ids = [];
  for (let index = 0; index < 4; index += 1) {
    const started = await client.call("codex_peer_delegate", {
      task: "SLOW",
      cwd: testDir,
    });
    ids.push(jobId(started));
  }
  const overflow = await client.call("codex_peer_delegate", {
    task: "SLOW",
    cwd: testDir,
  });
  assert.equal(overflow.result?.isError, true);
  assert.match(resultText(overflow), /4 active jobs/);
  for (const id of ids) await client.call("codex_peer_cancel", { job_id: id });

  const oversized = await client.call("codex_peer_delegate", {
    task: "x".repeat(256 * 1024 + 1),
    cwd: testDir,
  });
  assert.equal(oversized.result?.isError, true);
  assert.match(resultText(oversized), /task exceeds/);

  const huge = await client.call("codex_peer_delegate", {
    task: "HUGE",
    cwd: testDir,
  });
  const hugeId = jobId(huge);
  assert.equal((await waitForTerminal(client, hugeId)).status, "failed");
  const hugeResult = await client.call("codex_peer_result", { job_id: hugeId });
  assert.match(resultText(hugeResult), /output exceeded 1024 bytes/);
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
    name: "codex_peer_delegate",
    arguments: {},
  });
  assert.equal(malformed.error?.code, -32602);
  assert.match(malformed.error?.message, /Missing required argument/);
  await client.close();
});

test("packaged MCP configuration launches the package-relative bridge", async () => {
  const config = JSON.parse(await readFile(new URL("../.mcp.json", import.meta.url), "utf8"));
  const server = config.mcpServers.codex_peer;
  assert.equal(server.command, "node");
  assert.equal(server.args[0], "./scripts/codex-peer-mcp.mjs");
  assert.equal(server.cwd, ".");
  const resolvedCwd = isAbsolute(server.cwd) ? server.cwd : resolve(pluginRoot, server.cwd);

  const child = spawn(server.command, server.args, {
    cwd: resolvedCwd,
    env: {
      ...process.env,
      CODEX_PEER_CLI: fakeCodexPath,
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
