# Peer Server

Local Codex plugins for running independent coding-agent sessions.

## Plugins

- `codex-peer`: starts a second local Codex session through `codex app-server`.
- `claude-peer`: starts Claude Code in non-interactive mode through the local `claude` CLI.

Both plugins use background jobs. A long-running review or delegated task returns a
`job_id` immediately; callers poll the matching status tool and retrieve the result
after the job reaches a terminal state.

Each bridge accepts at most four concurrent jobs, caps task input at 256 KiB and
captured output at 8 MiB, and retains the latest 50 terminal jobs. Cancellation
first enters `cancelling`, terminates the worker process group, escalates from
`SIGTERM` to `SIGKILL` when necessary, and only then reports `cancelled`.

## Installation

### Directly from GitHub (recommended)

Register this repository as a Codex plugin marketplace, then install either or
both plugins:

```bash
codex plugin marketplace add ItsukiYoshida/peer-server --ref main
codex plugin add codex-peer@peer-server
codex plugin add claude-peer@peer-server
```

No clone or symlink is required. Start a new Codex session after installation so
the new MCP servers are loaded.

### From a local checkout

Use a local marketplace while developing or testing repository changes:

```bash
git clone https://github.com/ItsukiYoshida/peer-server.git
cd peer-server
codex plugin marketplace add "$PWD"
codex plugin add codex-peer@peer-server
codex plugin add claude-peer@peer-server
```

The `@peer-server` suffix comes from the marketplace name in
`.agents/plugins/marketplace.json`. A personal marketplace and `~/plugins`
symlinks are not required.

The packaged MCP configurations launch their bridge scripts relative to each plugin
root, so installed cache snapshots do not depend on a separate source checkout.

## Claude authentication

`claude-peer` does not store an API key or OAuth token. It inherits the authentication
available to the local Claude Code CLI.

```bash
claude auth status --json
```

For a local interactive installation, signing in with a Claude Pro, Max, Team, or
Enterprise account is sufficient. Claude Code stores that login in the operating
system credential store. For a headless environment, `claude setup-token` can create
a long-lived subscription OAuth token that is supplied as
`CLAUDE_CODE_OAUTH_TOKEN`.

`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` take precedence over the saved
subscription login. Do not set them when the intended billing source is the Claude
subscription.

The plugin deliberately does not use Claude Code `--bare` mode because bare mode
does not read subscription OAuth credentials or the system credential store.

## Claude isolation

Every delegated Claude process uses `--safe-mode`, a strict empty MCP configuration,
and subprocess credential scrubbing. User and repository Claude settings, hooks,
plugins, skills, `CLAUDE.md`, and auto-memory are not loaded. Include any required
repository instructions in the delegated task.

Read-only jobs use plan mode, disable edit tools, and apply an OS sandbox rule that
denies Bash writes across the filesystem. Writable jobs use accept-edits mode and
allow writes only within Claude Code's default workspace sandbox. Both modes fail
closed when sandboxing is unavailable and prohibit unsandboxed command fallback.

## Validation

```bash
just fix
just check
```
