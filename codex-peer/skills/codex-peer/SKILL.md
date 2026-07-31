---
name: codex-peer
description: Use when a second, independent Codex pass would help with review, adversarial analysis, or delegating a well-scoped coding task. Prefer codex_peer_review for read-only work; use codex_peer_delegate only when the user explicitly wants another Codex session to edit files.
---

# Codex Peer

This plugin exposes another local Codex session through the Codex app server.

Nested peer sessions do not expose `codex-peer` tools. This is intentional: it
prevents recursive peer spawning while leaving other MCP and SubAgent tools
available to the nested session.

- Use `codex_peer_review` for a read-only second opinion on the current working tree or a branch diff.
- Use `codex_peer_delegate` for a task that another Codex session should investigate or implement. Set `allow_writes` to `true` only when the user explicitly authorizes file changes.
- Use `codex_peer_follow_up` with a returned `thread_id` to continue the same delegated session.
- `codex_peer_review`, `codex_peer_delegate`, and `codex_peer_follow_up` start background jobs and immediately return a `job_id`. Poll with `codex_peer_status`; after it reaches a terminal state, retrieve the response with `codex_peer_result`.
- Use `codex_peer_start` for an explicitly constructed background task and `codex_peer_cancel` to stop one.
- At most four jobs may run concurrently. Tasks larger than 256 KiB and captured responses larger than 8 MiB are rejected. Cancellation reports `cancelling` until the worker process group has actually stopped.

The peer runs in the current workspace by default and uses the local `codex` login and configuration. Report the peer's final response and thread ID; do not claim that a review or edit happened unless the tool result confirms it.
