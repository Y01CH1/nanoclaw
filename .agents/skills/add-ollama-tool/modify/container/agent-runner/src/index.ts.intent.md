# Intent: container/agent-runner/src/index.ts modifications

## What changed
Added Ollama MCP server configuration so the container agent can call local Ollama models as tools.

## Key sections

### mcpServers object
- Added: `ollama` entry as a stdio MCP server
  - command: `'node'`
  - args: `['/tmp/dist/ollama-mcp-stdio.js']`
  - enabled tools: `ollama_list_models`, `ollama_generate`

## Invariants (must-keep)
- nanoclaw MCP server config unchanged
- The managed Codex config flow is unchanged
- `runWrapperFromStdin()` and output markers are unchanged
