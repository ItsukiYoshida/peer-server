set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

codex_home := env_var_or_default("CODEX_HOME", home_directory() + "/.codex")
plugin_validator := env_var_or_default("CODEX_PLUGIN_VALIDATOR", codex_home + "/skills/.system/plugin-creator/scripts/validate_plugin.py")
skill_validator := env_var_or_default("CODEX_SKILL_VALIDATOR", codex_home + "/skills/.system/skill-creator/scripts/quick_validate.py")

install:
    codex plugin marketplace add "$PWD"
    codex plugin add codex-peer@peer-server
    codex plugin add claude-peer@peer-server

fix:
    just --fmt

check:
    just --fmt --check
    node -e 'JSON.parse(require("node:fs").readFileSync(".agents/plugins/marketplace.json", "utf8"))'
    node --check plugins/codex-peer/scripts/codex-peer-mcp.mjs
    node --check plugins/codex-peer/tests/fake-codex.mjs
    node --check plugins/codex-peer/tests/codex-peer-mcp.test.mjs
    node --check plugins/claude-peer/scripts/claude-peer-mcp.mjs
    node --check plugins/claude-peer/tests/fake-claude.mjs
    node --check plugins/claude-peer/tests/claude-peer-mcp.test.mjs
    node --test plugins/codex-peer/tests/codex-peer-mcp.test.mjs
    node --test plugins/claude-peer/tests/claude-peer-mcp.test.mjs
    python3 "{{ plugin_validator }}" plugins/codex-peer
    python3 "{{ plugin_validator }}" plugins/claude-peer
    python3 "{{ skill_validator }}" plugins/codex-peer/skills/codex-peer
    python3 "{{ skill_validator }}" plugins/claude-peer/skills/claude-peer
