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

check component="all":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{ component }}" in
      all)
        just _check-code
        just _check-infra
        ;;
      code)
        just _check-code
        ;;
      infra)
        just _check-infra
        ;;
      *)
        echo "unknown check component: {{ component }}" >&2
        exit 2
        ;;
    esac

_check-code:
    node --check plugins/codex-peer/scripts/codex-peer-mcp.mjs
    node --check plugins/codex-peer/tests/fake-codex.mjs
    node --check plugins/codex-peer/tests/codex-peer-mcp.test.mjs
    node --check plugins/claude-peer/scripts/claude-peer-mcp.mjs
    node --check plugins/claude-peer/tests/fake-claude.mjs
    node --check plugins/claude-peer/tests/claude-peer-mcp.test.mjs
    node --test plugins/codex-peer/tests/codex-peer-mcp.test.mjs
    node --test plugins/claude-peer/tests/claude-peer-mcp.test.mjs

_check-infra:
    just --fmt --check
    actionlint -color
    node --test tests/plugin-packaging.test.mjs
    test "$(readlink codex-peer)" = plugins/codex-peer
    test "$(readlink claude-peer)" = plugins/claude-peer
    python3 "{{ plugin_validator }}" plugins/codex-peer
    python3 "{{ plugin_validator }}" plugins/claude-peer
    python3 "{{ skill_validator }}" plugins/codex-peer/skills/codex-peer
    python3 "{{ skill_validator }}" plugins/claude-peer/skills/claude-peer
