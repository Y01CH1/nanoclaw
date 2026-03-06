# Intent: container/agent-runner/src/index.ts modifications

## What changed
Added Gmail MCP server to the agent's available tools so it can read and send emails.

## Key sections

### mcpServers object
- Added: `gmail` MCP server alongside the existing `nanoclaw` server:
  ```
  gmail: {
    command: 'npx',
    args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
  },
  ```

## Invariants
- The `nanoclaw` MCP server configuration is unchanged
- The managed Codex config flow is unchanged
- The query loop, IPC handling, MessageStream, and all other logic is untouched
- Hooks (PreCompact, sanitize Bash) are unchanged
- Output protocol (markers) is unchanged

## Must-keep
- The `nanoclaw` MCP server with its environment variables
- The hook system (PreCompact, PreToolUse sanitize)
- The IPC input/close sentinel handling
- The MessageStream class and query loop
