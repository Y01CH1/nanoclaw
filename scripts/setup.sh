#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

emit_status() {
  local step="$1"
  shift
  printf '=== NANOCLAW SETUP: %s ===\n' "$step"
  while [ "$#" -gt 0 ]; do
    printf '%s\n' "$1"
    shift
  done
  printf '=== END ===\n'
}

platform_name() {
  if [ -n "${SETUP_PLATFORM_OVERRIDE:-}" ]; then
    printf '%s\n' "$SETUP_PLATFORM_OVERRIDE"
    return
  fi

  case "$(uname -s)" in
    Darwin) printf 'macos\n' ;;
    Linux) printf 'linux\n' ;;
    *) printf 'unknown\n' ;;
  esac
}

normalize_cmd_name() {
  printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | sed 's/[^A-Z0-9]/_/g'
}

has_cmd() {
  local name="$1"
  local normalized override
  normalized="$(normalize_cmd_name "$name")"
  override="SETUP_HAS_${normalized}"

  if [ "${!override+x}" = x ]; then
    [ "${!override}" = "1" ]
    return
  fi

  command -v "$name" >/dev/null 2>&1
}

run_privileged() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

linux_package_manager() {
  if has_cmd apt-get; then
    printf 'apt-get\n'
    return
  fi
  if has_cmd dnf; then
    printf 'dnf\n'
    return
  fi
  if has_cmd yum; then
    printf 'yum\n'
    return
  fi
  printf '\n'
}

ensure_homebrew() {
  if has_cmd brew; then
    emit_status "BOOTSTRAP_HOMEBREW" \
      "STATUS: skipped" \
      "DETAIL: already_installed"
    return
  fi

  echo "[setup] Homebrew not found, installing it"
  if sh -lc 'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'; then
    emit_status "BOOTSTRAP_HOMEBREW" \
      "STATUS: success" \
      "DETAIL: installed"
    return
  fi

  emit_status "BOOTSTRAP_HOMEBREW" \
    "STATUS: failed" \
    "ERROR: homebrew_install_failed"
  exit 1
}

ensure_build_tools() {
  local platform
  platform="$(platform_name)"

  if [ "$platform" = "macos" ]; then
    if has_cmd xcode-select && xcode-select -p >/dev/null 2>&1; then
      emit_status "BOOTSTRAP_BUILD_TOOLS" \
        "STATUS: skipped" \
        "DETAIL: already_ready"
      return
    fi

    echo "[setup] Xcode Command Line Tools not found, installing them"
    xcode-select --install || true
    if ! xcode-select -p >/dev/null 2>&1; then
      emit_status "BOOTSTRAP_BUILD_TOOLS" \
        "STATUS: failed" \
        "ERROR: xcode_cli_tools_missing"
      echo "[setup] Finish the Xcode Command Line Tools installation, then rerun ./scripts/setup.sh"
      exit 1
    fi
    emit_status "BOOTSTRAP_BUILD_TOOLS" \
      "STATUS: success" \
      "DETAIL: installed"
    return
  fi

  if \
    { has_cmd gcc || has_cmd clang; } && \
    { has_cmd g++ || has_cmd clang++; } && \
    has_cmd make && \
    has_cmd python3; then
    emit_status "BOOTSTRAP_BUILD_TOOLS" \
      "STATUS: skipped" \
      "DETAIL: already_ready"
    return
  fi

  local manager
  manager="$(linux_package_manager)"
  if [ -z "$manager" ]; then
    emit_status "BOOTSTRAP_BUILD_TOOLS" \
      "STATUS: failed" \
      "ERROR: no_supported_package_manager"
    echo "[setup] No supported Linux package manager found for build tools"
    exit 1
  fi

  echo "[setup] Build tools not found, installing them with $manager"
  case "$manager" in
    apt-get)
      if ! run_privileged apt-get install -y build-essential python3; then
        emit_status "BOOTSTRAP_BUILD_TOOLS" \
          "STATUS: failed" \
          "ERROR: build_tools_install_failed"
        exit 1
      fi
      ;;
    dnf)
      if ! run_privileged dnf install -y gcc gcc-c++ make python3; then
        emit_status "BOOTSTRAP_BUILD_TOOLS" \
          "STATUS: failed" \
          "ERROR: build_tools_install_failed"
        exit 1
      fi
      ;;
    yum)
      if ! run_privileged yum install -y gcc gcc-c++ make python3; then
        emit_status "BOOTSTRAP_BUILD_TOOLS" \
          "STATUS: failed" \
          "ERROR: build_tools_install_failed"
        exit 1
      fi
      ;;
  esac
  emit_status "BOOTSTRAP_BUILD_TOOLS" \
    "STATUS: success" \
    "DETAIL: installed"
}

ensure_node_runtime() {
  if has_cmd node && has_cmd npm; then
    emit_status "BOOTSTRAP_NODE_RUNTIME" \
      "STATUS: skipped" \
      "DETAIL: already_installed"
    return
  fi

  local platform
  platform="$(platform_name)"

  if [ "$platform" = "macos" ]; then
    ensure_homebrew
    echo "[setup] Node.js/npm not found, installing them with Homebrew"
    if ! brew install node; then
      emit_status "BOOTSTRAP_NODE_RUNTIME" \
        "STATUS: failed" \
        "ERROR: node_install_failed"
      exit 1
    fi
    emit_status "BOOTSTRAP_NODE_RUNTIME" \
      "STATUS: success" \
      "DETAIL: installed_with_homebrew"
    return
  fi

  local manager
  manager="$(linux_package_manager)"
  if [ -z "$manager" ]; then
    emit_status "BOOTSTRAP_NODE_RUNTIME" \
      "STATUS: failed" \
      "ERROR: no_supported_package_manager"
    echo "[setup] No supported Linux package manager found for Node.js"
    exit 1
  fi

  echo "[setup] Node.js/npm not found, installing them with $manager"
  case "$manager" in
    apt-get)
      if ! run_privileged apt-get install -y nodejs npm; then
        emit_status "BOOTSTRAP_NODE_RUNTIME" \
          "STATUS: failed" \
          "ERROR: node_install_failed"
        exit 1
      fi
      ;;
    dnf)
      if ! run_privileged dnf install -y nodejs npm; then
        emit_status "BOOTSTRAP_NODE_RUNTIME" \
          "STATUS: failed" \
          "ERROR: node_install_failed"
        exit 1
      fi
      ;;
    yum)
      if ! run_privileged yum install -y nodejs npm; then
        emit_status "BOOTSTRAP_NODE_RUNTIME" \
          "STATUS: failed" \
          "ERROR: node_install_failed"
        exit 1
      fi
      ;;
  esac
  emit_status "BOOTSTRAP_NODE_RUNTIME" \
    "STATUS: success" \
    "DETAIL: installed"
}

bootstrap_system_dependencies() {
  emit_status "BOOTSTRAP_SYSTEM_DEPS" \
    "STATUS: running" \
    "PLATFORM: $(platform_name)"
  ensure_build_tools
  ensure_node_runtime
  emit_status "BOOTSTRAP_SYSTEM_DEPS" \
    "STATUS: success" \
    "PLATFORM: $(platform_name)"
}

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

step="${1:-guided}"

cd "$ROOT_DIR"
warn_deprecated_credentials
bootstrap_system_dependencies

if [ ! -d "$ROOT_DIR/node_modules" ]; then
  echo "[setup] node_modules not found, running npm install"
  npm install
fi

if [ "$step" = "guided" ]; then
  shift || true
  npm run setup -- --step guided -- "$@"
else
  shift || true
  npm run setup -- --step "$step" -- "$@"
fi
