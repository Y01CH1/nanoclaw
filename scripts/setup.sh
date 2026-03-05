#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

warn_deprecated_credentials() {
  local env_file="$ROOT_DIR/.env"
  [ -f "$env_file" ] || return 0

  local has_codex has_openai has_legacy
  has_codex=$(grep -E '^CODEX_API_KEY=' "$env_file" || true)
  has_openai=$(grep -E '^OPENAI_API_KEY=' "$env_file" || true)
  has_legacy=$(grep -E '^(ANTHROPIC_|CLAUDE_CODE_)' "$env_file" || true)

  if [ -z "$has_codex" ] && [ -z "$has_openai" ] && [ -n "$has_legacy" ]; then
    echo "[setup] deprecated credentials detected (ANTHROPIC_/CLAUDE_CODE_)."
    echo "[setup] preferred order: CODEX_API_KEY > OPENAI_API_KEY > ANTHROPIC_* > CLAUDE_CODE_*"
  fi
}

step="${1:-environment}"

cd "$ROOT_DIR"
warn_deprecated_credentials

if [ ! -d "$ROOT_DIR/node_modules" ]; then
  echo "[setup] node_modules not found, running npm install"
  npm install
fi

npm run setup -- --step "$step"
