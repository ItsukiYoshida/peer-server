---
name: claude-peer
description: Use when an independent Claude Code pass would help with review, adversarial analysis, investigation, or a well-scoped coding task. Prefer claude_peer_review for read-only work; use claude_peer_delegate with allow_writes only when the user has authorized file changes.
---

# Claude Peer

This plugin starts the locally installed Claude Code CLI in a separate process.
It uses the Claude authentication already available on the machine and never
stores an API key or subscription token.

- Use `claude_peer_auth_status` to confirm that Claude Code is authenticated.
  The result is sanitized and does not return account identifiers or credentials.
- Use `claude_peer_review` for a read-only second opinion on the current working
  tree or a branch diff. Reviews always run in Claude Code plan mode.
- Use `claude_peer_delegate` for investigation or implementation. It defaults to
  read-only. Set `allow_writes=true` only when the user's request authorizes file
  changes.
- Use `claude_peer_follow_up` with a returned `thread_id` to continue the same
  Claude Code session.
- `claude_peer_review`, `claude_peer_delegate`, and `claude_peer_follow_up`
  start background jobs and immediately return a `job_id`. Poll with
  `claude_peer_status`; after the job reaches a terminal state, retrieve the
  response with `claude_peer_result`.
- Use `claude_peer_start` for an explicitly constructed background task and
  `claude_peer_cancel` to stop one.

Every peer process uses Claude Code safe mode, an empty strict MCP configuration,
and subprocess credential scrubbing. User and repository settings, hooks, plugins,
skills, `CLAUDE.md`, and auto-memory are not loaded, so include relevant repository
instructions in the delegated task.

Read-only jobs use Claude Code plan mode with edit tools disabled and an OS
sandbox rule that denies Bash writes across the filesystem. Writable jobs use
accept-edits mode with the Claude Code sandbox enabled, unsandboxed command
fallback disabled, and writes restricted to the selected workspace by default.
Both modes fail closed when sandboxing is unavailable.

At most four jobs may run concurrently. Tasks larger than 256 KiB and captured
responses larger than 8 MiB are rejected. Cancellation reports `cancelling` until
the worker process group has actually stopped.

The plugin intentionally does not use Claude Code bare mode because bare mode
does not read subscription OAuth credentials or the operating system credential
store. A normal local Claude login is sufficient. `CLAUDE_CODE_OAUTH_TOKEN`
from `claude setup-token` is only needed for a headless environment without the
saved login.

Report the final Claude response and thread ID. Do not claim that a review,
investigation, or edit happened until the job completed and its result was
retrieved.
