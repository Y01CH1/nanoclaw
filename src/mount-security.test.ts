import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpRoot = '';
let allowlistPath = '';

async function loadModule() {
  vi.resetModules();
  vi.doMock('./config.js', () => ({
    MOUNT_ALLOWLIST_PATH: allowlistPath,
  }));
  return await import('./mount-security.js');
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mount-test-'));
  allowlistPath = path.join(tmpRoot, 'mount-allowlist.json');
});

afterEach(() => {
  vi.resetModules();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

describe('mount security gates', () => {
  it('forces non-main read-write mounts to readonly when policy requires it', async () => {
    const allowedRoot = path.join(tmpRoot, 'allowed');
    const target = path.join(allowedRoot, 'project');
    fs.mkdirSync(target, { recursive: true });

    fs.writeFileSync(
      allowlistPath,
      JSON.stringify(
        {
          allowedRoots: [{ path: allowedRoot, allowReadWrite: true }],
          blockedPatterns: [],
          nonMainReadOnly: true,
        },
        null,
        2,
      ),
    );

    const mod = await loadModule();
    const result = mod.validateMount(
      { hostPath: target, readonly: false },
      false,
    );

    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('blocks symlink paths that escape allowed roots', async () => {
    const allowedRoot = path.join(tmpRoot, 'allowed');
    const outsideRoot = path.join(tmpRoot, 'outside');
    const symlinkPath = path.join(allowedRoot, 'escape-link');

    fs.mkdirSync(allowedRoot, { recursive: true });
    fs.mkdirSync(outsideRoot, { recursive: true });
    fs.symlinkSync(outsideRoot, symlinkPath, 'dir');

    fs.writeFileSync(
      allowlistPath,
      JSON.stringify(
        {
          allowedRoots: [{ path: allowedRoot, allowReadWrite: true }],
          blockedPatterns: [],
          nonMainReadOnly: false,
        },
        null,
        2,
      ),
    );

    const mod = await loadModule();
    const result = mod.validateMount({ hostPath: symlinkPath }, true);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not under any allowed root');
  });

  it('rejects blocked patterns and keeps validated list empty', async () => {
    const allowedRoot = path.join(tmpRoot, 'allowed');
    const blockedDir = path.join(allowedRoot, '.ssh-secrets');

    fs.mkdirSync(blockedDir, { recursive: true });
    fs.writeFileSync(
      allowlistPath,
      JSON.stringify(
        {
          allowedRoots: [{ path: allowedRoot, allowReadWrite: true }],
          blockedPatterns: [],
          nonMainReadOnly: false,
        },
        null,
        2,
      ),
    );

    const mod = await loadModule();
    const mounts = mod.validateAdditionalMounts(
      [{ hostPath: blockedDir, containerPath: 'ssh-data' }],
      'security-group',
      true,
    );

    expect(mounts).toEqual([]);
  });
});
