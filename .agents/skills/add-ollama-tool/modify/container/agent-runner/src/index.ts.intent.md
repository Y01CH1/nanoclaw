# Intent: container/agent-runner/src/index.ts modifications

## What changed
Added Ollama MCP server configuration so the container agent can call local Ollama models as tools.

## Key sections

### allowedTools array
- Added: `'mcp__ollama__*'` to the allowedTools array (after `'mcp__nanoclaw__*'`)

### mcpServers object
- Added: `ollama` entry as a stdio MCP server
  - command: `'node'`
  - args: `['/tmp/dist/ollama-mcp-stdio.js']`

## Invariants (must-keep)
- All existing allowedTools entries unchanged
- nanoclaw MCP server config unchanged
- The managed Codex config flow is unchanged
- `runWrapperFromStdin()` and output markers are unchanged
