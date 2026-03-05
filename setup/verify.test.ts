import { describe, expect, it } from 'vitest';

import { detectCredentialStatus } from './verify.js';

describe('detectCredentialStatus', () => {
  it('prefers CODEX_API_KEY over legacy credentials', () => {
    const status = detectCredentialStatus(
      'ANTHROPIC_API_KEY=legacy\nCODEX_API_KEY=codex-key',
    );
    expect(status).toEqual({ status: 'configured', source: 'codex' });
  });

  it('uses OPENAI_API_KEY when codex key is missing', () => {
    const status = detectCredentialStatus('OPENAI_API_KEY=openai-key');
    expect(status).toEqual({ status: 'configured', source: 'openai' });
  });

  it('marks anthropic-only config as deprecated', () => {
    const status = detectCredentialStatus('ANTHROPIC_BASE_URL=https://x');
    expect(status).toEqual({
      status: 'deprecated_config',
      source: 'anthropic',
    });
  });

  it('marks claude-code-only config as deprecated', () => {
    const status = detectCredentialStatus('CLAUDE_CODE_OAUTH_TOKEN=tok');
    expect(status).toEqual({
      status: 'deprecated_config',
      source: 'claude_code',
    });
  });

  it('returns missing when no supported credentials exist', () => {
    const status = detectCredentialStatus('ASSISTANT_NAME=Andy');
    expect(status).toEqual({ status: 'missing', source: 'none' });
  });
});
