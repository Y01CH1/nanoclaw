import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('add-gmail skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: gmail');
    expect(content).toContain('version: 2.0.0');
    expect(content).toContain('core_version: 1.2.6');
    expect(content).toContain('googleapis');
  });

  it('has channel file with self-registration', () => {
    const channelFile = path.join(
      skillDir,
      'add',
      'src',
      'channels',
      'gmail.ts',
    );
    expect(fs.existsSync(channelFile)).toBe(true);

    const content = fs.readFileSync(channelFile, 'utf-8');
    expect(content).toContain('class GmailChannel');
    expect(content).toContain('implements Channel');
    expect(content).toContain("registerChannel('gmail'");
  });

  it('has channel barrel file modification', () => {
    const indexFile = path.join(
      skillDir,
      'modify',
      'src',
      'channels',
      'index.ts',
    );
    expect(fs.existsSync(indexFile)).toBe(true);

    const indexContent = fs.readFileSync(indexFile, 'utf-8');
    expect(indexContent).toContain("import './gmail.js'");
  });

  it('has intent files for modified files', () => {
    expect(
      fs.existsSync(
        path.join(skillDir, 'modify', 'src', 'channels', 'index.ts.intent.md'),
      ),
    ).toBe(true);
  });

  it('has container-runner mount modification', () => {
    const crFile = path.join(
      skillDir,
      'modify',
      'src',
      'container-runner.ts',
    );
    expect(fs.existsSync(crFile)).toBe(true);

    const content = fs.readFileSync(crFile, 'utf-8');
    expect(content).toContain('.gmail-mcp');
    expect(content).toContain('/home/node/.codex');
    expect(content).not.toContain('.claude');
    expect(content).not.toContain('CLAUDE_CODE_');
  });

  it('has agent-runner Gmail MCP server modification', () => {
    const arFile = path.join(
      skillDir,
      'modify',
      'container',
      'agent-runner',
      'src',
      'index.ts',
    );
    expect(fs.existsSync(arFile)).toBe(true);

    const content = fs.readFileSync(arFile, 'utf-8');
    expect(content).toContain('@gongrzhe/server-gmail-autoauth-mcp');
    expect(content).toContain("import { runWrapperFromStdin, writeOutput } from './codex-wrapper.js';");
    expect(content).toContain('gmail: {');
    expect(content).not.toContain('@anthropic-ai/claude-agent-sdk');
    expect(content).not.toContain('preset: \'claude_code\'');
  });

  it('has test file for the channel', () => {
    const testFile = path.join(
      skillDir,
      'add',
      'src',
      'channels',
      'gmail.test.ts',
    );
    expect(fs.existsSync(testFile)).toBe(true);

    const testContent = fs.readFileSync(testFile, 'utf-8');
    expect(testContent).toContain("describe('GmailChannel'");
  });
});
