import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('x-integration skill', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('uses MCP SDK rather than the claude agent sdk', () => {
    const agentPath = path.join(skillDir, 'agent.ts');
    const content = fs.readFileSync(agentPath, 'utf-8');

    expect(content).toContain('@modelcontextprotocol/sdk/server/mcp.js');
    expect(content).toContain('new StdioServerTransport()');
    expect(content).not.toContain('@anthropic-ai/claude-agent-sdk');
    expect(content).not.toContain('createXTools');
  });

  it('defines the X MCP tools and main-group guard', () => {
    const agentPath = path.join(skillDir, 'agent.ts');
    const content = fs.readFileSync(agentPath, 'utf-8');

    expect(content).toContain("server.tool(\n  'x_post'");
    expect(content).toContain("server.tool(\n  'x_like'");
    expect(content).toContain("server.tool(\n  'x_reply'");
    expect(content).toContain("server.tool(\n  'x_retweet'");
    expect(content).toContain("server.tool(\n  'x_quote'");
    expect(content).toContain('Only the main group can use X integration tools.');
  });

  it('documents codex runner integration rather than claude sdk hooks', () => {
    const skillPath = path.join(skillDir, 'SKILL.md');
    const content = fs.readFileSync(skillPath, 'utf-8');

    expect(content).toContain("enabledTools: ['x_post', 'x_like', 'x_reply', 'x_retweet', 'x_quote']");
    expect(content).toContain('/tmp/dist/skills/x-integration/agent.js');
    expect(content).not.toContain('@anthropic-ai/claude-agent-sdk');
    expect(content).not.toContain('createXTools');
  });
});
