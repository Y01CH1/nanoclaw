---
name: debug
description: Debug NanoClaw container agent issues. Use when the service is not responding, Codex credentials are missing, container startup fails, messages do not flow, or you need to inspect mounts, logs, and runner state.
---

# NanoClaw Container Debugging

This guide covers the current Codex-only container path.

## Architecture Overview

```
Host (macOS/Linux)                    Container
─────────────────────────────────────────────────────────────
src/container-runner.ts               container/agent-runner/
    │                                      │
    │ spawns runtime                        │ runs codex-wrapper
    │ with bind mounts + env                │ with managed MCP config
    │                                      │
    ├── groups/{folder} ─────────────> /workspace/group
    ├── groups/global (non-main) ────> /workspace/global
    ├── data/ipc/{folder} ───────────> /workspace/ipc
    ├── data/sessions/{folder}/.codex ──> /home/node/.codex
    ├── data/sessions/{folder}/agent-runner-src ──> /app/src
    └── (main only) project root ────> /workspace/project (read-only)
```

Important points:
- Codex session state is isolated per group in `data/sessions/{folder}/.codex/`
- Host `~/.codex/auth.json` may be seeded into a group's `.codex/` on first run
- The main project root is mounted read-only
- Group-local agent-runner source is mounted at `/app/src`

## Log Locations

| Log | Location | Content |
|------|----------|---------|
| Main app logs | `logs/nanoclaw.log` | Host-side routing, scheduler, container lifecycle |
| Main app errors | `logs/nanoclaw.error.log` | Host-side failures |
| Container run logs | `groups/{folder}/logs/container-*.log` | Per-run input, mounts, stdout, stderr, parsed output |

## First Checks

### 1. Verify setup state

```bash
./scripts/verify.sh
```

Look for:
- credential state
- channel registration state
- runtime readiness
- startup blockers

### 2. Enable debug logging

```bash
LOG_LEVEL=debug npm run dev
```

For services, set `LOG_LEVEL=debug` in launchd/systemd environment config.

Debug logging shows:
- container mount configuration
- container arguments
- streamed stderr lines
- parsed output warnings

## Common Issues

### 1. `CODEX_CREDENTIAL_MISSING`

This means NanoClaw could not find usable Codex credentials.

Valid credential sources:
- `CODEX_API_KEY` in `.env`
- `OPENAI_API_KEY` in `.env`
- `data/sessions/{group}/.codex/auth.json`
- host `~/.codex/auth.json` for first-run seed

Check:

```bash
grep -E '^(CODEX_API_KEY|OPENAI_API_KEY)=' .env
ls -la ~/.codex
ls -la data/sessions/main/.codex
```

If only keyring-backed Codex login exists, NanoClaw will not auto-import it. Use file-based auth or an env key.

### 2. Container runtime not available

Check:

```bash
docker info
```

If Docker is installed but access fails:
- macOS: start Docker Desktop
- Linux: `sudo systemctl start docker`
- Linux socket permissions: ensure the current user can access `/var/run/docker.sock`

Apple Container is secondary support. If debugging the primary path, prefer Docker first.

### 3. No response to messages

Check:

```bash
tail -f logs/nanoclaw.log
./scripts/verify.sh
```

Common causes:
- service not running
- channel registered incompletely
- container image missing
- Codex credentials missing
- trigger mismatch

### 4. Container exits unexpectedly

Inspect the latest run log:

```bash
ls -t groups/*/logs/container-*.log | head -3
tail -n 80 groups/main/logs/container-*.log
```

Look for:
- stderr tail
- parsed output payload
- timeout messages
- malformed JSON or missing output markers

### 5. Session not resuming

Codex session state lives in:

```bash
data/sessions/{group}/.codex/
```

Check:

```bash
ls -la data/sessions/main/.codex
```

You should typically see:
- `auth.json` when file-based auth is available
- `config.toml` when host config has been seeded

If every turn creates a new session:
- inspect the latest container log for resume fallback
- verify the mount target is `/home/node/.codex`
- verify the group `.codex/` directory is writable

### 6. MCP server failures

NanoClaw writes managed Codex MCP config into:

```bash
data/sessions/{group}/.codex/config.toml
```

Inspect:

```bash
cat data/sessions/main/.codex/config.toml
```

You should see a managed block containing at least `nanoclaw`, and any enabled optional MCP servers such as Gmail or Ollama.

## Manual Inspection

### Check current mount assumptions

```bash
grep -n "/home/node/.codex" src/container-runner.ts
grep -n "agent-runner-src" src/container-runner.ts
grep -n "CODEX_API_KEY" src/container-runner.ts
```

### Check recent startup guidance

```bash
tail -n 80 logs/nanoclaw.error.log
tail -n 120 logs/nanoclaw.log
```

### Check group IPC

```bash
find data/ipc -maxdepth 3 -type f | sort
```

Important IPC locations:
- `data/ipc/{group}/messages/`
- `data/ipc/{group}/tasks/`
- `data/ipc/{group}/input/`

## Manual Container Testing

### Docker smoke

```bash
npm run test:docker-smoke
```

This is the fastest end-to-end sanity check for:
- image build
- container startup
- output marker parsing

### Interactive shell

```bash
docker run --rm -it --entrypoint /bin/bash nanoclaw-agent:latest
```

### Check the built agent-runner payload

```bash
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c '
  ls -la /tmp/dist
  ls -la /app/src
'
```

## Rebuild After Changes

```bash
npm run build
./container/build.sh
```

If you suspect stale image state:

```bash
docker builder prune -f
./container/build.sh
```

## Quick Diagnostic Script

```bash
echo "=== Checking NanoClaw Codex Container Setup ==="

echo -e "\n1. Codex env key configured?"
grep -Eq '^(CODEX_API_KEY|OPENAI_API_KEY)=' .env 2>/dev/null && echo "OK" || echo "MISSING - add CODEX_API_KEY or OPENAI_API_KEY, or rely on ~/.codex/auth.json"

echo -e "\n2. Host Codex auth file present?"
[ -f ~/.codex/auth.json ] && echo "OK" || echo "NOT FOUND - file-based auth unavailable on host"

echo -e "\n3. Container runtime running?"
docker info >/dev/null 2>&1 && echo "OK" || echo "NOT RUNNING - start Docker Desktop or docker service"

echo -e "\n4. Container image exists?"
echo '{}' | docker run -i --entrypoint /bin/echo nanoclaw-agent:latest "OK" 2>/dev/null || echo "MISSING - run ./container/build.sh"

echo -e "\n5. Codex mount path correct?"
grep -q "/home/node/.codex" src/container-runner.ts 2>/dev/null && echo "OK" || echo "WRONG - expected /home/node/.codex mount"

echo -e "\n6. Group session dir exists?"
ls -la data/sessions 2>/dev/null || echo "MISSING - no session directories yet"

echo -e "\n7. Recent container logs?"
ls -t groups/*/logs/container-*.log 2>/dev/null | head -3 || echo "No container logs yet"

echo -e "\n8. Verify summary"
./scripts/verify.sh || true
```

## Escalation Path

If the issue is still unclear after these checks:
1. Capture the latest `groups/{folder}/logs/container-*.log`
2. Capture `./scripts/verify.sh`
3. Capture the relevant `logs/nanoclaw.log` tail
4. Check whether the failure is host runtime, credential state, MCP config, or channel registration
