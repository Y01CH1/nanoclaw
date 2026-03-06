import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
  };
});

import { handleXIpc } from './x-integration.js';

describe('x integration IPC bridge', () => {
  beforeEach(() => {
    fakeProc = createFakeProcess();
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ignores non x task types', async () => {
    await expect(
      handleXIpc({ type: 'schedule_task' }, 'main', true, '/tmp/data'),
    ).resolves.toBe(false);
  });

  it('blocks x tasks outside the main group', async () => {
    await expect(
      handleXIpc(
        { type: 'x_post', requestId: 'req-1' },
        'other',
        false,
        '/tmp/data',
      ),
    ).resolves.toBe(true);
  });

  it('runs the matching host script and writes a result file', async () => {
    const promise = handleXIpc(
      {
        type: 'x_post',
        requestId: 'req-1',
        content: 'hello world',
      },
      'main',
      true,
      '/tmp/data',
    );

    fakeProc.stdout.push('{"success":true,"message":"posted"}\n');
    fakeProc.emit('close', 0);

    await expect(promise).resolves.toBe(true);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/tmp/data/ipc/main/x_results/req-1.json',
      JSON.stringify({ success: true, message: 'posted' }),
    );
  });
});
