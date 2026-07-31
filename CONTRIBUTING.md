# Contributing to Peer Server

Thank you for contributing. This repository contains Codex plugins that start
independent Codex or Claude Code sessions through MCP bridges. Changes to the
bridges can affect process isolation, filesystem access, authentication, and
credential handling, so keep changes focused and cover behavior changes with
tests.

## Prerequisites

Install the following tools before working on the repository:

- Git
- Node.js with the built-in `node:test` runner
- [just](https://github.com/casey/just)
- [actionlint](https://github.com/rhysd/actionlint) 1.7.12
- Python 3

The full validation command also uses the plugin and skill validators from a
local Codex installation. Their locations are defined at the top of the
`Justfile`. The automated bridge tests use fake Codex and Claude executables, so
they do not require network access, credentials, or authenticated CLI sessions.

Real Codex or Claude Code installations are only needed for optional manual
integration testing.

## Repository layout

```text
.agents/plugins/marketplace.json
plugins/
├── codex-peer/
│   ├── .codex-plugin/plugin.json
│   ├── .mcp.json
│   ├── scripts/
│   ├── skills/
│   └── tests/
└── claude-peer/
    ├── .codex-plugin/plugin.json
    ├── .mcp.json
    ├── scripts/
    ├── skills/
    └── tests/
```

The directories under `plugins/` are the canonical plugin sources.
`.agents/plugins/marketplace.json` exposes them through the repository's Codex
plugin marketplace. Keep the marketplace paths and plugin names in sync when
changing the package layout.

Each plugin keeps its bridge implementation, skill instructions, package
metadata, and tests together. If behavior visible to an agent changes, update
the implementation, tests, and relevant skill or README documentation in the
same contribution.

## Development workflow

1. Create a focused branch from the latest default branch.
2. Make the smallest change that solves the problem.
3. Add or update tests for the changed behavior.
4. Run a targeted test while iterating.
5. Run the complete repository checks before opening a pull request.

Run one plugin's tests with:

```bash
node --test plugins/codex-peer/tests/codex-peer-mcp.test.mjs
node --test plugins/claude-peer/tests/claude-peer-mcp.test.mjs
```

Run the final validation gates with:

```bash
just fix
just check
```

`just fix` formats the `Justfile`. `just check` verifies the `Justfile` and
GitHub Actions workflows, checks plugin packaging and JavaScript syntax, runs
both bridge test suites, and validates both plugin packages and their skills. If
a required validator is unavailable, run every remaining check and clearly
describe the validation limitation in the pull request.

The CI workflow runs the repository checks as separate components:

```bash
just check code
just check infra
```

Infra CI downloads checksum-pinned copies of the official plugin and skill
validators from a pinned OpenAI Codex revision. Local checks use the equivalent
validators supplied by the local Codex installation.

## Implementation guidelines

- Follow the existing ECMAScript module style: two-space indentation, double
  quotes, semicolons, and trailing commas in multiline structures.
- Prefer Node.js standard-library APIs. The bridges intentionally have no
  package installation step or runtime dependency tree.
- Keep MCP tool schemas strict. Reject unknown arguments, validate value types
  and ranges, and return protocol errors for malformed calls.
- Keep background work bounded. Preserve the concurrency, task-size,
  output-size, timeout, and terminal-job retention limits unless the change is
  specifically about those limits.
- Treat cancellation as a process-lifecycle operation. Do not report a job as
  cancelled until its worker process group has stopped.
- Keep tool descriptions, skill instructions, and implementation behavior in
  sync.
- Never commit credentials, tokens, local account identifiers, generated
  caches, or machine-specific authentication state.

The two bridge implementations share concepts but integrate with different
CLIs. Avoid copying behavior between them without checking the target CLI's
process model, authentication, resume mechanism, and sandbox semantics.

## Security invariants

Changes must preserve these properties unless the pull request explicitly
changes and justifies one of them:

- Read-only review and delegation must not gain write access.
- Writable delegation must remain an explicit opt-in.
- Sandbox setup must fail closed when the required isolation is unavailable.
- Nested peer invocation must remain blocked to prevent recursive spawning.
- Credentials and sensitive environment variables must not be exposed to peer
  processes or returned in tool results.
- Claude authentication status must remain sanitized.
- User and repository configuration must not silently weaken the isolation
  promised by the plugin.

Add a regression test whenever a change touches an isolation boundary, process
termination, input validation, output capture, authentication, or session
resume behavior.

## Testing guidelines

Tests use the fake executables in each plugin's `tests/` directory. Prefer these
fakes over live CLI calls so tests remain deterministic and do not consume
external service capacity.

For a behavior change, cover both the successful path and the relevant failure
or boundary condition. In particular, consider:

- read-only versus writable invocation arguments;
- asynchronous job state transitions;
- follow-up session or thread reuse;
- timeout and cancellation behavior;
- concurrency, input, output, and retention limits;
- MCP protocol negotiation and invalid requests;
- package-relative startup through `.mcp.json`.

Tests that start child processes must clean them up even when an assertion
fails. Do not leave background Codex or Claude processes running after a test.

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
messages and pull request titles. Use a plugin scope when it makes the affected
area clearer, for example:

```text
fix(codex-peer): reject malformed follow-up requests
test(claude-peer): cover cancellation escalation
docs: add local validation guidance
```

Keep each pull request focused. Its description should include:

- the problem and intended behavior;
- the affected plugin or shared workflow;
- security or compatibility implications;
- tests and validation commands run;
- any manual integration testing performed;
- anything that could not be validated locally.

Do not include credentials, raw authentication output, or sensitive peer
responses in commits, logs, screenshots, or pull request descriptions.

By contributing, you agree that your contribution is licensed under the
repository's [MIT License](LICENSE).
