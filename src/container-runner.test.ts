import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs, { PathLike } from 'fs';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false, mtimeMs: Date.now() })),
      lstatSync: vi.fn(() => ({
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      })),
      cpSync: vi.fn(),
      copyFileSync: vi.fn(),
      openSync: vi.fn(() => 99),
      closeSync: vi.fn(),
      unlinkSync: vi.fn(),
      renameSync: vi.fn(),
      chmodSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

const mockReadEnvFile = vi.fn(() => ({}));
vi.mock('./env.js', () => ({
  readEnvFile: (...args: unknown[]) => mockReadEnvFile(...args),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.unstubAllEnvs();
    mockReadEnvFile.mockReset();
    mockReadEnvFile.mockReturnValue({});
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });

  it('keeps claude path behavior when AGENT_BACKEND=claude', async () => {
    vi.stubEnv('AGENT_BACKEND', 'claude');
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Claude path unchanged',
      newSessionId: 'session-claude',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-claude');

    const { spawn } = await import('child_process');
    const spawnMock = vi.mocked(spawn);
    const [, args] = spawnMock.mock.calls.at(-1)!;
    expect(args).toContain('-e');
    expect(args).toContain('AGENT_BACKEND=claude');
  });

  it('mounts per-group .codex sessions and propagates resolved backend', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Codex mount check',
      newSessionId: 'session-codex',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');

    const { spawn } = await import('child_process');
    const spawnMock = vi.mocked(spawn);
    const [, args] = spawnMock.mock.calls.at(-1)!;
    const expectedBackend =
      process.env.AGENT_BACKEND?.trim().toLowerCase() === 'claude'
        ? 'claude'
        : 'codex';
    expect(args).toContain(`AGENT_BACKEND=${expectedBackend}`);
    expect(args).toContain(
      '/tmp/nanoclaw-test-data/sessions/test-group/.codex:/home/node/.codex',
    );
  });

  it('normalizes legacy error field into message in non-streaming mode', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    emitOutputMarker(fakeProc, {
      status: 'error',
      result: null,
      error: 'Legacy error message',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.message).toBe('Legacy error message');
  });

  it('syncs newly added agent-runner files without overwriting existing group copy', async () => {
    const existsSyncMock = vi.mocked(fs.existsSync);
    existsSyncMock.mockImplementation((p: PathLike) => {
      const str = String(p);
      return (
        str.includes('container/agent-runner/src') ||
        str.includes('sessions/test-group/agent-runner-src')
      );
    });

    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'seed merge',
      newSessionId: 'session-seed',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');

    const cpSyncMock = vi.mocked(fs.cpSync);
    expect(cpSyncMock).toHaveBeenCalledWith(
      expect.stringContaining('container/agent-runner/src'),
      expect.stringContaining('sessions/test-group/agent-runner-src'),
      expect.objectContaining({
        recursive: true,
        force: false,
        errorOnExist: false,
      }),
    );
  });

  it('injects CODEX_API_KEY and OPENAI_API_KEY into container stdin secrets', async () => {
    mockReadEnvFile.mockReturnValue({
      CODEX_API_KEY: 'codex-test-key',
      OPENAI_API_KEY: 'openai-test-key',
    });

    let stdinPayload = '';
    fakeProc.stdin.on('data', (chunk) => {
      stdinPayload += chunk.toString();
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
      newSessionId: 'session-secret',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');

    const parsedInput = JSON.parse(stdinPayload) as {
      secrets?: Record<string, string>;
    };
    expect(parsedInput.secrets?.CODEX_API_KEY).toBe('codex-test-key');
    expect(parsedInput.secrets?.OPENAI_API_KEY).toBe('openai-test-key');
  });

  it('seeds group .codex auth.json from host auth when missing', async () => {
    const existsSyncMock = vi.mocked(fs.existsSync);
    const readFileSyncMock = vi.mocked(fs.readFileSync);
    const writeFileSyncMock = vi.mocked(fs.writeFileSync);
    const renameSyncMock = vi.mocked(fs.renameSync);
    const openSyncMock = vi.mocked(fs.openSync);

    let groupAuthExists = false;
    existsSyncMock.mockImplementation((p: PathLike) => {
      const str = String(p);
      if (str.endsWith('/.codex/auth.json')) {
        if (str.includes('/tmp/nanoclaw-test-data/sessions/test-group/')) {
          return groupAuthExists;
        }
        if (str.includes('/.codex/auth.json')) {
          return true;
        }
      }
      return false;
    });

    readFileSyncMock.mockImplementation((p: PathLike) => {
      const str = String(p);
      if (str.endsWith('/.codex/auth.json')) return Buffer.from('{"token":"x"}');
      return '';
    });

    renameSyncMock.mockImplementation((_tmp, dest) => {
      if (String(dest).includes('/tmp/nanoclaw-test-data/sessions/test-group/.codex/auth.json')) {
        groupAuthExists = true;
      }
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'seeded',
      newSessionId: 'session-seed-auth',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(openSyncMock).toHaveBeenCalledWith(
      '/tmp/nanoclaw-test-data/sessions/test-group/.codex/.seed.lock',
      'wx',
      0o600,
    );
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining(
        '/tmp/nanoclaw-test-data/sessions/test-group/.codex/auth.json.tmp-',
      ),
      expect.anything(),
      expect.objectContaining({ mode: 0o600 }),
    );
    expect(renameSyncMock).toHaveBeenCalledWith(
      expect.stringContaining('.tmp-'),
      '/tmp/nanoclaw-test-data/sessions/test-group/.codex/auth.json',
    );
  });
});
