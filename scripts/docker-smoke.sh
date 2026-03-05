#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="nanoclaw-agent:smoke"
START_MARKER='---NANOCLAW_OUTPUT_START---'
END_MARKER='---NANOCLAW_OUTPUT_END---'

if ! command -v docker >/dev/null 2>&1; then
  echo "[docker-smoke] docker is not installed"
  exit 1
fi

echo "[docker-smoke] building image ${IMAGE_TAG}"
docker build -t "${IMAGE_TAG}" -f "${ROOT_DIR}/container/Dockerfile" "${ROOT_DIR}/container"

INPUT_JSON='{"prompt":"smoke","groupFolder":"smoke-group","chatJid":"smoke@g.us","isMain":false}'

echo "[docker-smoke] running container with fake codex binary"
OUTPUT="$({ printf '%s' "${INPUT_JSON}"; } | docker run --rm -i \
  -e AGENT_BACKEND=codex \
  -e PATH=/tmp/fake-codex:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  -v "${ROOT_DIR}/scripts/smoke/fake-codex:/tmp/fake-codex:ro" \
  "${IMAGE_TAG}")"

printf '%s\n' "${OUTPUT}"

JSON_PAYLOAD="$(printf '%s\n' "${OUTPUT}" | awk -v s="${START_MARKER}" -v e="${END_MARKER}" '
  $0==s {capture=1; next}
  $0==e {capture=0}
  capture {print}
' | tail -n 1)"

if [ -z "${JSON_PAYLOAD}" ]; then
  echo "[docker-smoke] failed: no marker-wrapped JSON payload found"
  exit 1
fi

node -e '
const payload = process.argv[1];
const data = JSON.parse(payload);
if (!data || typeof data.status !== "string") {
  throw new Error("invalid payload shape");
}
if (data.status !== "success") {
  throw new Error(`unexpected status: ${data.status}`);
}
if (typeof data.result !== "string" || data.result.length === 0) {
  throw new Error("missing result text");
}
console.log("[docker-smoke] parsed payload OK");
' "${JSON_PAYLOAD}"
