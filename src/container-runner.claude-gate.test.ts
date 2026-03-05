import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  TIMEZONE: 'America/Los_Angeles',
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

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
      statSync: vi.fn(() => ({ isDirectory: () => false })),
    },
  };
});

vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.pid = 4321;
  return proc;
}

let fakeProc = createFakeProcess();

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

import { runContainerAgent } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const group: RegisteredGroup = {
  name: 'Claude Gate Group',
  folder: 'claude-gate-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const input = {
  prompt: 'hello',
  groupFolder: 'claude-gate-group',
  chatJid: 'claude@g.us',
  isMain: false,
};

function emitOutput(output: object): void {
  fakeProc.stdout.push(
    `${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`,
  );
}

describe('claude backend gate', () => {
  beforeEach(() => {
    vi.stubEnv('AGENT_BACKEND', 'claude');
    fakeProc = createFakeProcess();
  });

  it('starts container and streams marker output in claude backend', async () => {
    const streamed: string[] = [];
    const promise = runContainerAgent(
      group,
      input,
      () => {},
      async (o) => {
        if (o.result) streamed.push(o.result);
      },
    );

    emitOutput({ status: 'success', result: 'stream ok', newSessionId: 's1' });
    fakeProc.emit('close', 0);

    const result = await promise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('s1');
    expect(streamed).toEqual(['stream ok']);

    const { spawn } = await import('child_process');
    const spawnMock = vi.mocked(spawn);
    const [, args] = spawnMock.mock.calls.at(-1)!;
    expect(args).toContain('AGENT_BACKEND=claude');
  });

  it('parses non-stream marker schema in claude backend', async () => {
    const promise = runContainerAgent(group, input, () => {});
    emitOutput({
      status: 'error',
      result: null,
      message: 'FAILED_SCHEMA',
      warnings: [{ code: 'X' }],
      newSessionId: 's2',
    });
    fakeProc.emit('close', 0);

    const result = await promise;
    expect(result.status).toBe('error');
    expect(result.message).toBe('FAILED_SCHEMA');
    expect(result.newSessionId).toBe('s2');
    expect(result.warnings?.[0]?.code).toBe('X');
  });

  it('keeps basic task-style success contract in claude backend', async () => {
    const promise = runContainerAgent(group, input, () => {});
    emitOutput({ status: 'success', result: 'task result', newSessionId: 's3' });
    fakeProc.emit('close', 0);

    const result = await promise;
    expect(result.status).toBe('success');
    expect(result.result).toBe('task result');
    expect(result.newSessionId).toBe('s3');
  });
});
