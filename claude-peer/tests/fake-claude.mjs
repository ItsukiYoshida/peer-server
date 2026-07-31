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
  })}\n`,
);
