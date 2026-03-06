# Intent: src/container-runtime.ts modifications

## What changed
Replaced the default Docker runtime with Apple Container. This is a full file replacement and must stay Codex-only; it should not reintroduce legacy session directories, legacy SDK assumptions, or backend switching.

## Key sections

### CONTAINER_RUNTIME_BIN
- Changed: `'docker'` → `'container'` (the Apple Container CLI binary)

### readonlyMountArgs
- Changed: Docker `-v host:container:ro` → Apple Container `--mount type=bind,source=...,target=...,readonly`

### ensureContainerRuntimeRunning
- Changed: `docker info` → `container system status` for checking
- Added: auto-start via `container system start` when not running (Apple Container supports this; Docker requires manual start)
- Changed: error message references Apple Container instead of Docker

### cleanupOrphans
- Changed: `docker ps --filter name=nanoclaw- --format '{{.Names}}'` → `container ls --format json` with JSON parsing
- Apple Container returns JSON with `{ status, configuration: { id } }` structure

## Invariants
- All five exports remain identical: `CONTAINER_RUNTIME_BIN`, `readonlyMountArgs`, `stopContainer`, `ensureContainerRuntimeRunning`, `cleanupOrphans`
- `stopContainer` implementation is unchanged (`<bin> stop <name>`)
- Logger usage pattern is unchanged
- Error handling pattern is unchanged
- No references to legacy session directories or rollback-window behavior

## Must-keep
- The exported function signatures (consumed by container-runner.ts and index.ts)
- The error box-drawing output format
- The orphan cleanup logic (find + stop pattern)
