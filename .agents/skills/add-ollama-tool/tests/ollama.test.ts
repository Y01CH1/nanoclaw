import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('add-ollama-tool skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a current codex manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    const content = fs.readFileSync(manifestPath, 'utf-8');

    expect(content).toContain('skill: ollama');
    expect(content).toContain('version: 2.0.0');
    expect(content).toContain('core_version: 1.2.6');
  });

  it('patches the codex agent runner with ollama MCP', () => {
    const indexPath = path.join(
      skillDir,
      'modify',
      'container',
      'agent-runner',
      'src',
      'index.ts',
    );
    const content = fs.readFileSync(indexPath, 'utf-8');

    expect(content).toContain(
      "import { runWrapperFromStdin, writeOutput } from './codex-wrapper.js';",
    );
    expect(content).toContain('/tmp/dist/ollama-mcp-stdio.js');
    expect(content).toContain("enabledTools: ['ollama_list_models', 'ollama_generate']");
    expect(content).not.toContain('@anthropic-ai/claude-agent-sdk');
    expect(content).not.toContain("preset: 'claude_code'");
  });

  it('patches container logging without reintroducing claude sessions', () => {
    const containerRunnerPath = path.join(
      skillDir,
      'modify',
      'src',
      'container-runner.ts',
    );
    const content = fs.readFileSync(containerRunnerPath, 'utf-8');

    expect(content).toContain("line.includes('[OLLAMA]')");
    expect(content).toContain("containerPath: '/home/node/.codex'");
    expect(content).not.toContain('.claude');
    expect(content).not.toContain('CLAUDE_CODE_');
  });
});
