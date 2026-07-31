#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const turns = new Map();

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function completeTurn(threadId, turnId, status = "completed", error) {
  write({
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turnId,
        threadId,
        status,
        ...(error ? { error: { message: error } } : {}),
      },
    },
  });
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const params = message.params || {};

  if (message.method === "initialize") {
    write({ id: message.id, result: {} });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    write({ id: message.id, result: { thread: { id: randomUUID() } } });
    return;
  }
  if (message.method === "thread/resume") {
    write({ id: message.id, result: { thread: { id: params.threadId } } });
    return;
  }
  if (message.method === "turn/start") {
    const threadId = params.threadId;
    const turnId = randomUUID();
    const task = params.input?.[0]?.text || "";
    turns.set(threadId, { turnId, task });
    write({ id: message.id, result: { turn: { id: turnId } } });

    if (task.includes("SLOW_DESCENDANT")) {
      spawn(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
        ],
        { stdio: "ignore" },
      );
      process.on("SIGTERM", () => process.exit(0));
      return;
    }
    if (task.includes("SLOW")) {
      process.on("SIGTERM", () => {});
      return;
    }
    setTimeout(() => {
      if (task.includes("HUGE")) {
        write({
          method: "item/agentMessage/delta",
          params: { threadId, delta: "x".repeat(2048) },
        });
        return;
      }
      const text = task.includes("ECHO_CONFIG")
        ? JSON.stringify({
            sandboxPolicy: params.sandboxPolicy,
            approvalPolicy: params.approvalPolicy,
          })
        : task.includes("FOLLOW_UP")
          ? "FOLLOW_UP_OK"
          : "FAKE_OK";
      write({
        method: "item/completed",
        params: {
          threadId,
          item: {
            threadId,
            type: "agentMessage",
            phase: "final_answer",
            text,
          },
        },
      });
      if (task.includes("FAIL")) {
        completeTurn(threadId, turnId, "failed", "fake Codex failure");
      } else {
        completeTurn(threadId, turnId);
      }
    }, 10);
    return;
  }
});

input.on("close", () => process.exit(0));
