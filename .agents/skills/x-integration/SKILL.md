---
name: x-integration
description: Add X (Twitter) browser automation as MCP tools. Use when setting up, testing, or troubleshooting X posting, liking, replying, retweeting, or quoting from NanoClaw.
---

# X (Twitter) Integration

This skill provides a host-side browser automation bridge plus a container-side MCP server template for X interactions.

The current Codex-only shape is:
- host process handles `x_*` IPC requests
- container process exposes X actions as MCP tools over stdio
- Codex calls the MCP tools, which write IPC tasks for the host

## Features

| Action | Tool | Description |
|--------|------|-------------|
| Post | `x_post` | Publish new tweets |
| Like | `x_like` | Like a tweet |
| Reply | `x_reply` | Reply to a tweet |
| Retweet | `x_retweet` | Retweet without comment |
| Quote | `x_quote` | Quote tweet with comment |

## Prerequisites

Before using this skill:

1. NanoClaw is already installed and running
2. Host browser automation dependencies are available:
   ```bash
   npm ls playwright dotenv-cli || npm install playwright dotenv-cli
   ```
3. Chrome is installed, and `CHROME_PATH` is set in `.env` if Chrome is not at the default path

## Quick Start

```bash
# 1. Authenticate X in the host browser profile
npx dotenv -e .env -- npx tsx .agents/skills/x-integration/scripts/setup.ts

# 2. Copy the container-side MCP server into agent-runner source
mkdir -p container/agent-runner/src/skills/x-integration
cp .agents/skills/x-integration/agent.ts container/agent-runner/src/skills/x-integration/agent.ts

# 3. Rebuild container and host app
./container/build.sh
npm run build

# 4. Restart NanoClaw
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# Linux: systemctl --user restart nanoclaw
```

## Architecture

```
Container
  skills/x-integration/agent.ts
    -> exposes MCP tools x_post/x_like/x_reply/x_retweet/x_quote
    -> writes x_* IPC task files into /workspace/ipc/tasks
    -> waits for result files in /workspace/ipc/x_results

Host
  .agents/skills/x-integration/host.ts
    -> handles x_* IPC tasks
    -> runs Playwright scripts on the host
    -> writes result files back for the container MCP server
```

## Integration Steps

### 1. Host side: wire X IPC handling into `src/ipc.ts`

Add:

```ts
import { handleXIpc } from '../.agents/skills/x-integration/host.js';
```

In the task IPC switch/default path, delegate unknown task types:

```ts
const handled = await handleXIpc(data, sourceGroup, isMain, DATA_DIR);
if (!handled) {
  logger.warn({ type: data.type }, 'Unknown IPC task type');
}
```

### 2. Container side: add the MCP server to `container/agent-runner/src/index.ts`

Add an `x` MCP server entry:

```ts
x: {
  command: 'node',
  args: ['/tmp/dist/skills/x-integration/agent.js'],
  env: {
    NANOCLAW_GROUP_FOLDER: process.env.NANOCLAW_GROUP_FOLDER ?? '',
    NANOCLAW_IS_MAIN: process.env.NANOCLAW_IS_MAIN ?? '0',
  },
  enabledTools: ['x_post', 'x_like', 'x_reply', 'x_retweet', 'x_quote'],
},
```

Do not replace the existing `nanoclaw` server. Add `x` alongside it.

### 3. Rebuild the container

Because the X MCP server file is compiled as part of `container/agent-runner/src`, rebuilding the container is required:

```bash
./container/build.sh
```

### 4. Restart the host service

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# Linux: systemctl --user restart nanoclaw
```

## Verification

Tell the user to try a safe action first:

```text
use x_post to draft and send: "Test tweet from NanoClaw - please ignore"
```

Then monitor:

```bash
tail -f logs/nanoclaw.log | grep -i x
```

Expected flow:
- Codex sees `mcp__x__x_post`, `mcp__x__x_like`, `mcp__x__x_reply`, `mcp__x__x_retweet`, and `mcp__x__x_quote`
- container calls the selected `x_*` MCP tool
- host logs `Processing X request`
- the corresponding Playwright script runs
- a result file is written back and the MCP tool returns success/failure

## Troubleshooting

### X tools do not appear inside the container

Check:

```bash
grep -n "enabledTools: \\['x_post'" container/agent-runner/src/index.ts
grep -n "skills/x-integration/agent.js" container/agent-runner/src/index.ts
ls -la container/agent-runner/src/skills/x-integration
```

### X request never completes

Check IPC directories:

```bash
find data/ipc -maxdepth 3 -type f | sort | grep x_
```

The usual failure modes are:
- `src/ipc.ts` is not delegating to `handleXIpc()`
- the Playwright script failed on the host
- the result file was never written back

### Browser login expired

Run setup again:

```bash
npx dotenv -e .env -- npx tsx .agents/skills/x-integration/scripts/setup.ts
```

### Main-group restriction

X tools are intentionally limited to the main group. If a non-main group calls them, the MCP server returns an error.

## Files

```
.agents/skills/x-integration/
├── SKILL.md
├── agent.ts          # Container-side stdio MCP server template
├── host.ts           # Host-side IPC handler
├── lib/
│   ├── browser.ts
│   └── config.ts
└── scripts/
    ├── setup.ts
    ├── post.ts
    ├── like.ts
    ├── reply.ts
    ├── retweet.ts
    └── quote.ts
```
