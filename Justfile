set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

plugin_validator := "/Users/cat/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py"
skill_validator := "/Users/cat/.codex/skills/.system/skill-creator/scripts/quick_validate.py"

fix:
    just --fmt

check:
    just --fmt --check
    node --check codex-peer/scripts/codex-peer-mcp.mjs
    node --check codex-peer/tests/fake-codex.mjs
    node --check codex-peer/tests/codex-peer-mcp.test.mjs
    node --check claude-peer/scripts/claude-peer-mcp.mjs
    node --check claude-peer/tests/fake-claude.mjs
    node --check claude-peer/tests/claude-peer-mcp.test.mjs
    node --test codex-peer/tests/codex-peer-mcp.test.mjs
    node --test claude-peer/tests/claude-peer-mcp.test.mjs
    python3 {{ plugin_validator }} codex-peer
    python3 {{ plugin_validator }} claude-peer
    python3 {{ skill_validator }} codex-peer/skills/codex-peer
    python3 {{ skill_validator }} claude-peer/skills/claude-peer
