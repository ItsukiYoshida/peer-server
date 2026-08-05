#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);

if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(
    `${JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      email: "must-not-leak@example.com",
      orgId: "must-not-leak",
      subscriptionType: "max",
    })}\n`,
  );
  process.exit(0);
}

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;

// The bridge appends a delegated-job notice to every task, so scenario
// selectors match on the first line of the prompt rather than the whole text.
const promptKey = prompt.trim().split("\n", 1)[0].trim();

if (promptKey === "USAGE_LIMIT") {
  process.stderr.write(
    "Permission mode forced to default — CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is set\n",
  );
  process.stdout.write(
    `${JSON.stringify({
      is_error: true,
      subtype: "error_during_execution",
      session_id: randomUUID(),
      api_error_status: 429,
      error: "rate_limit",
      result: "You've hit your session limit · resets 4:10pm (Asia/Tokyo)",
    })}\n`,
  );
  process.exit(1);
}

const namedUsageLimits = new Map([
  ["FAST_USAGE_LIMIT", "You've hit your fast limit"],
  ["MONTHLY_USAGE_LIMIT", "You've hit your monthly limit"],
  ["MONTHLY_SPEND_USAGE_LIMIT", "You've hit your monthly spend limit"],
  ["FABLE_USAGE_LIMIT", "You've reached your Fable 5 limit."],
  ["WEEKLY_USAGE_LIMIT", "You've hit your weekly limit"],
  ["OPUS_USAGE_LIMIT", "You've reached your Opus limit."],
  ["SONNET_USAGE_LIMIT", "You've hit your Sonnet limit"],
]);
if (namedUsageLimits.has(promptKey)) {
  process.stdout.write(
    `${JSON.stringify({
      is_error: true,
      subtype: "error_during_execution",
      error: "rate_limit",
      result: namedUsageLimits.get(promptKey),
    })}\n`,
  );
  process.exit(1);
}

if (prompt.includes("TEMPORARY_RATE_LIMIT")) {
  process.stderr.write(
    "Permission mode forced to default — CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is set\n",
  );
  process.stdout.write(
    `${JSON.stringify({
      is_error: true,
      subtype: "error_during_execution",
      api_error_status: 429,
      error: "rate_limit",
      result: "Server is temporarily limiting requests (not your usage limit)",
    })}\n`,
  );
  process.exit(1);
}

if (prompt.includes("EMPTY_FAILURE")) {
  process.exit(1);
}

if (prompt.includes("FAIL")) {
  process.stderr.write("fake Claude failure\n");
  process.exit(2);
}

if (prompt.includes("HUGE")) {
  process.stdout.write("x".repeat(2048));
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

if (prompt.includes("SLOW_DESCENDANT")) {
  spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
    ],
    { stdio: "ignore" },
  );
  process.on("SIGTERM", () => process.exit(0));
  await new Promise((resolve) => setTimeout(resolve, 5000));
} else if (prompt.includes("SLOW")) {
  process.on("SIGTERM", () => {});
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

const resumeIndex = args.indexOf("--resume");
const sessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : randomUUID();
const result = prompt.includes("ECHO_ARGS")
  ? JSON.stringify({
      args,
      codexHome: process.env.CODEX_HOME ?? null,
      maxSessionHistoryEvents:
        process.env.CLAUDE_PEER_MAX_SESSION_HISTORY_EVENTS ?? null,
      sessionHistoryDir:
        process.env.CLAUDE_PEER_SESSION_HISTORY_DIR ?? null,
      subprocessEnvScrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB,
    })
  : prompt.includes("FOLLOW_UP")
    ? "FOLLOW_UP_OK"
    : "FAKE_OK";

process.stdout.write(
  `${JSON.stringify({
    is_error: false,
    subtype: "success",
    session_id: sessionId,
    result,
    permission_denials: [],
    duration_ms: 10,
    num_turns: 1,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
    },
    total_cost_usd: 0.01,
  })}\n`,
);
