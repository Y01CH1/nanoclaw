import { describe, expect, it } from 'vitest';

import {
  detectCredentialStatus,
  isCredentialStatusAllowedForBackend,
  resolveCredentialStatus,
} from './verify.js';

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

describe('resolveCredentialStatus', () => {
  it('uses main group auth file when no codex/openai keys exist', () => {
    const detected = detectCredentialStatus('ANTHROPIC_API_KEY=legacy');
    const status = resolveCredentialStatus(detected, {
      hasMainGroupAuthFile: true,
      hasHostAuthFile: false,
    });
    expect(status).toEqual({
      status: 'configured',
      source: 'codex_auth_file',
    });
  });

  it('marks configured_pending_seed only when host auth exists and main auth is missing', () => {
    const detected = detectCredentialStatus('ASSISTANT_NAME=Andy');
    const status = resolveCredentialStatus(detected, {
      hasMainGroupAuthFile: false,
      hasHostAuthFile: true,
    });
    expect(status).toEqual({
      status: 'configured_pending_seed',
      source: 'codex_auth_file',
    });
  });

  it('falls back to deprecated only when codex keys and auth files are absent', () => {
    const detected = detectCredentialStatus('CLAUDE_CODE_OAUTH_TOKEN=legacy');
    const status = resolveCredentialStatus(detected, {
      hasMainGroupAuthFile: false,
      hasHostAuthFile: false,
    });
    expect(status).toEqual({
      status: 'deprecated_config',
      source: 'claude_code',
    });
  });
});

describe('isCredentialStatusAllowedForBackend', () => {
  it('disallows deprecated credentials for codex backend', () => {
    expect(
      isCredentialStatusAllowedForBackend('codex', 'deprecated_config'),
    ).toBe(false);
  });

  it('allows deprecated credentials for claude backend', () => {
    expect(
      isCredentialStatusAllowedForBackend('claude', 'deprecated_config'),
    ).toBe(true);
  });

  it('allows pending seed status for both backends', () => {
    expect(
      isCredentialStatusAllowedForBackend('codex', 'configured_pending_seed'),
    ).toBe(true);
    expect(
      isCredentialStatusAllowedForBackend('claude', 'configured_pending_seed'),
    ).toBe(true);
  });
});
