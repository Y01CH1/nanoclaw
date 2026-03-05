import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { describe, expect, it } from 'vitest';

import {
  MAX_STDIN_BYTES,
  readStdinWithLimit,
  runWrapperFromStdin,
} from './codex-wrapper.js';

interface Scenario {
  stdoutLines: string[];
  stderr?: string;
  exitCode?: number;
}

type SpawnReturn = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: () => boolean;
};

function createSpawnMock(scenarios: Scenario[]) {
  let call = 0;
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];

  const fn = (command: string, args: string[], options: { cwd: string }) => {
    calls.push({ command, args, cwd: options.cwd });
    const scenario = scenarios[call++];
    if (!scenario) throw new Error('No scenario configured');

    const proc = new EventEmitter() as SpawnReturn;
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = () => true;

    queueMicrotask(() => {
      for (const line of scenario.stdoutLines) {
        proc.stdout.write(`${line}\n`);
      }
      proc.stdout.end();
      if (scenario.stderr) {
        proc.stderr.write(scenario.stderr);
      }
      proc.stderr.end();
      proc.emit('close', scenario.exitCode ?? 0);
    });

    return proc;
  };

  return Object.assign(fn, { calls });
}

describe('codex-wrapper input guards', () => {
  it('rejects oversized stdin payloads', async () => {
    const input = new PassThrough();
    input.end(Buffer.alloc(MAX_STDIN_BYTES + 1, 'a'));

    await expect(readStdinWithLimit(input)).rejects.toMatchObject({
      code: 'INPUT_TOO_LARGE',
    });
  });

  it('returns structured error on bad stdin json', async () => {
    const input = new PassThrough();
    input.end('{bad json');

    const result = await runWrapperFromStdin(input, {
      spawnFn: createSpawnMock([]) as never,
    });

    expect(result.exitCode).toBe(1);
    expect(result.output.status).toBe('error');
    expect(result.output.message).toBe('INPUT_JSON_PARSE_ERROR');
    expect(result.output.warnings?.[0]?.code).toBe('INPUT_JSON_PARSE_ERROR');
  });

  it('returns structured error when stdin exceeds 1MB', async () => {
    const input = new PassThrough();
    input.end(Buffer.alloc(MAX_STDIN_BYTES + 2, 'x'));

    const result = await runWrapperFromStdin(input, {
      spawnFn: createSpawnMock([]) as never,
    });

    expect(result.output.status).toBe('error');
    expect(result.output.message).toBe('INPUT_TOO_LARGE');
    expect(result.output.warnings?.[0]?.code).toBe('INPUT_TOO_LARGE');
    expect(result.output.warnings?.[0]?.meta?.maxBytes).toBe(
      String(MAX_STDIN_BYTES),
    );
  });
});

describe('codex-wrapper jsonl state machine', () => {
  it('uses last agent_message text even if it appears after turn.completed', async () => {
    const spawnFn = createSpawnMock([
      {
        stdoutLines: [
          JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
          JSON.stringify({ type: 'turn.completed' }),
          JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'agent_message',
              message: {
                content: [
                  { type: 'text', text: 'hello ' },
                  { type: 'text', text: 'world' },
                ],
              },
            },
          }),
        ],
      },
    ]);

    const input = new PassThrough();
    input.end(
      JSON.stringify({
        prompt: 'p',
        groupFolder: 'g',
        chatJid: 'c',
        isMain: false,
      }),
    );

    const result = await runWrapperFromStdin(input, {
      spawnFn: spawnFn as never,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output.status).toBe('success');
    expect(result.output.result).toBe('hello world');
    expect(result.output.newSessionId).toBe('thread-1');
  });

  it('returns NO_AGENT_MESSAGE when stream has no agent_message', async () => {
    const spawnFn = createSpawnMock([
      {
        stdoutLines: [
          JSON.stringify({ type: 'thread.started', thread_id: 'thread-2' }),
          JSON.stringify({ type: 'turn.completed' }),
        ],
      },
    ]);

    const input = new PassThrough();
    input.end(
      JSON.stringify({
        prompt: 'p',
        groupFolder: 'g',
        chatJid: 'c',
        isMain: false,
      }),
    );

    const result = await runWrapperFromStdin(input, {
      spawnFn: spawnFn as never,
    });

    expect(result.output.status).toBe('error');
    expect(result.output.message).toBe('NO_AGENT_MESSAGE');
    expect(
      result.output.warnings?.some((w) => w.code === 'NO_AGENT_MESSAGE'),
    ).toBe(true);
  });

  it('returns THREAD_ID_MISSING when no thread.started is seen', async () => {
    const spawnFn = createSpawnMock([
      {
        stdoutLines: [
          JSON.stringify({ type: 'turn.completed' }),
          JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'agent_message',
              message: { content: [{ type: 'text', text: 'x' }] },
            },
          }),
        ],
      },
    ]);

    const input = new PassThrough();
    input.end(
      JSON.stringify({
        prompt: 'p',
        groupFolder: 'group-a',
        chatJid: 'c',
        isMain: false,
      }),
    );

    const result = await runWrapperFromStdin(input, {
      spawnFn: spawnFn as never,
    });

    expect(result.output.status).toBe('error');
    expect(result.output.message).toBe('THREAD_ID_MISSING');
    expect(result.output.newSessionId).toBeNull();
  });

  it('falls back from resume and reports SESSION_RESUME_FAILED', async () => {
    const spawnFn = createSpawnMock([
      {
        stdoutLines: [
          JSON.stringify({ type: 'thread.started', thread_id: 'old-thread' }),
          JSON.stringify({ type: 'turn.failed', message: 'boom' }),
        ],
        exitCode: 1,
      },
      {
        stdoutLines: [
          JSON.stringify({ type: 'thread.started', thread_id: 'new-thread' }),
          JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'agent_message',
              message: { content: [{ type: 'text', text: 'ok' }] },
            },
          }),
          JSON.stringify({ type: 'turn.completed' }),
        ],
      },
    ]);

    const input = new PassThrough();
    input.end(
      JSON.stringify({
        prompt: 'p',
        sessionId: 'old-session',
        groupFolder: 'group-b',
        chatJid: 'c',
        isMain: false,
      }),
    );

    const result = await runWrapperFromStdin(input, {
      spawnFn: spawnFn as never,
    });

    expect(result.output.status).toBe('success');
    expect(result.output.newSessionId).toBe('new-thread');
    const warn = result.output.warnings?.find(
      (w) => w.code === 'SESSION_RESUME_FAILED',
    );
    expect(warn?.meta?.oldSessionId).toBe('old-session');
    expect(warn?.meta?.newSessionId).toBe('new-thread');
    expect(warn?.meta?.group).toBe('group-b');
    expect(spawnFn.calls[0]?.command).toBe('codex');
    expect(spawnFn.calls[0]?.args).toEqual([
      'exec',
      'resume',
      'old-session',
      '--json',
      '--skip-git-repo-check',
    ]);
    expect(spawnFn.calls[1]?.args).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
    ]);
  });

  it('passes sandbox mode flags to codex exec', async () => {
    const spawnFn = createSpawnMock([
      {
        stdoutLines: [
          JSON.stringify({ type: 'thread.started', thread_id: 'thread-sbx' }),
          JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'agent_message',
              message: { content: [{ type: 'text', text: 'ok' }] },
            },
          }),
          JSON.stringify({ type: 'turn.completed' }),
        ],
      },
      {
        stdoutLines: [
          JSON.stringify({ type: 'thread.started', thread_id: 'thread-sbx-2' }),
          JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'agent_message',
              message: { content: [{ type: 'text', text: 'ok2' }] },
            },
          }),
          JSON.stringify({ type: 'turn.completed' }),
        ],
      },
    ]);

    const input1 = new PassThrough();
    input1.end(
      JSON.stringify({
        prompt: 'p',
        groupFolder: 'g',
        chatJid: 'c',
        isMain: false,
        sandboxMode: 'full-auto',
      }),
    );
    await runWrapperFromStdin(input1, { spawnFn: spawnFn as never });
    expect(spawnFn.calls[0]?.args).toContain('--full-auto');

    const input2 = new PassThrough();
    input2.end(
      JSON.stringify({
        prompt: 'p',
        groupFolder: 'g',
        chatJid: 'c',
        isMain: false,
        sandboxMode: 'danger-full-access',
      }),
    );
    await runWrapperFromStdin(input2, { spawnFn: spawnFn as never });
    expect(spawnFn.calls[1]?.args).toContain('--danger-full-access');
  });

  it('defaults to readonly mode and does not auto-enable elevated sandbox flags', async () => {
    const spawnFn = createSpawnMock([
      {
        stdoutLines: [
          JSON.stringify({ type: 'thread.started', thread_id: 'thread-default' }),
          JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'agent_message',
              message: { content: [{ type: 'text', text: 'ok' }] },
            },
          }),
          JSON.stringify({ type: 'turn.completed' }),
        ],
      },
    ]);

    const input = new PassThrough();
    input.end(
      JSON.stringify({
        prompt: 'p',
        groupFolder: 'g',
        chatJid: 'c',
        isMain: false,
      }),
    );
    await runWrapperFromStdin(input, { spawnFn: spawnFn as never });

    expect(spawnFn.calls[0]?.args).not.toContain('--full-auto');
    expect(spawnFn.calls[0]?.args).not.toContain('--danger-full-access');
  });

  it('locks teams parity to wrapper aggregation by default', async () => {
    const spawnFn = createSpawnMock([
      {
        stdoutLines: [
          JSON.stringify({ type: 'thread.started', thread_id: 'thread-team' }),
          JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'agent_message',
              message: { content: [{ type: 'text', text: 'alpha' }] },
            },
          }),
          JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'agent_message',
              message: { content: [{ type: 'text', text: 'beta' }] },
            },
          }),
          JSON.stringify({ type: 'turn.completed' }),
        ],
      },
    ]);

    const input = new PassThrough();
    input.end(
      JSON.stringify({
        prompt: 'p',
        groupFolder: 'g',
        chatJid: 'c',
        isMain: false,
      }),
    );
    const result = await runWrapperFromStdin(input, { spawnFn: spawnFn as never });

    expect(result.output.status).toBe('success');
    expect(result.output.result).toBe('alpha\n\nbeta');
    const modeWarning = result.output.warnings?.find(
      (w) => w.code === 'TEAMS_PARITY_MODE_LOCKED',
    );
    expect(modeWarning?.meta?.mode).toBe('wrapper-aggregate');
  });

  it('fails with JSONL_PARSE_ERROR after parse error threshold is exceeded', async () => {
    const badLines = Array.from({ length: 12 }, () => 'not-json-line');
    const spawnFn = createSpawnMock([
      {
        stdoutLines: [
          JSON.stringify({ type: 'thread.started', thread_id: 'thread-3' }),
          ...badLines,
        ],
        exitCode: 1,
      },
    ]);

    const input = new PassThrough();
    input.end(
      JSON.stringify({
        prompt: 'p',
        groupFolder: 'g',
        chatJid: 'c',
        isMain: false,
      }),
    );

    const result = await runWrapperFromStdin(input, {
      spawnFn: spawnFn as never,
    });

    expect(result.output.status).toBe('error');
    expect(result.output.message).toBe('JSONL_PARSE_ERROR');
  });

  it('redacts secrets in stderr warnings', async () => {
    const spawnFn = createSpawnMock([
      {
        stdoutLines: [
          JSON.stringify({ type: 'thread.started', thread_id: 'thread-4' }),
          JSON.stringify({ type: 'turn.failed', message: 'failed' }),
        ],
        stderr:
          'CODEX_API_KEY=abc123 Authorization: Bearer tok-xyz OPENAI_API_KEY=sk-super-secret',
        exitCode: 1,
      },
    ]);

    const input = new PassThrough();
    input.end(
      JSON.stringify({
        prompt: 'p',
        groupFolder: 'g',
        chatJid: 'c',
        isMain: false,
      }),
    );

    const result = await runWrapperFromStdin(input, {
      spawnFn: spawnFn as never,
    });

    const stderrWarn = result.output.warnings?.find(
      (w) => w.code === 'STDERR_TAIL',
    );
    expect(stderrWarn?.meta?.stderr_tail).toContain('[REDACTED]');
    expect(stderrWarn?.meta?.stderr_tail).not.toContain('abc123');
    expect(stderrWarn?.meta?.stderr_tail).not.toContain('sk-super-secret');
  });
});
