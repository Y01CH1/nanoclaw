import { spawn } from 'child_process';
import readline from 'readline';
import { Readable } from 'stream';

export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
export const MAX_STDIN_BYTES = 1024 * 1024; // 1MB
export const MAX_JSONL_PARSE_ERRORS = 10;
export const STDERR_TAIL_BYTES = 4096;

export type WrapperStatus = 'success' | 'error' | 'partial';

export interface WrapperWarning {
  code: string;
  message?: string;
  meta?: Record<string, string>;
}

export interface CodexContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  workingDir?: string;
  tools?: string[];
  model?: string;
  systemPrompt?: string;
  env?: Record<string, string>;
  sandboxMode?: 'readonly' | 'full-auto' | 'danger-full-access';
  teamsMode?: 'wrapper-aggregate' | 'codex-native';
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
}

export interface CodexContainerOutput {
  status: WrapperStatus;
  result: string | null;
  newSessionId?: string | null;
  message?: string;
  errors?: string[];
  warnings?: WrapperWarning[];
}

export interface WrapperRunResult {
  output: CodexContainerOutput;
  exitCode: number;
}

interface AttemptResult {
  output: CodexContainerOutput;
  processExitCode: number;
  sawThreadNotFound: boolean;
  sawTurnFailed: boolean;
}

const DEFAULT_TEAMS_MODE: 'wrapper-aggregate' | 'codex-native' =
  'wrapper-aggregate';

interface SpawnLike {
  (
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      stdio: ['pipe', 'pipe', 'pipe'];
    },
  ): {
    stdin: {
      write(chunk: string | Buffer): boolean;
      end(): void;
    };
    stdout: Readable;
    stderr: Readable;
    on(event: 'close', listener: (code: number | null) => void): void;
    on(event: 'error', listener: (error: Error) => void): void;
    kill(signal?: NodeJS.Signals | number): boolean;
  };
}

function toStringValue(value: unknown, maxLen = 4096): string {
  if (typeof value === 'string') return value.slice(0, maxLen);
  if (value == null) return '';
  try {
    const serialized = JSON.stringify(value);
    return (serialized ?? String(value)).slice(0, maxLen);
  } catch {
    return String(value).slice(0, maxLen);
  }
}

export function normalizeMeta(
  meta: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!meta) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = toStringValue(v);
  }
  return out;
}

function appendTail(current: string, next: string, max = STDERR_TAIL_BYTES * 8): string {
  const merged = current + next;
  if (Buffer.byteLength(merged, 'utf8') <= max) return merged;
  return Buffer.from(merged, 'utf8').subarray(-max).toString('utf8');
}

function tailBytes(input: string, maxBytes: number): string {
  const buf = Buffer.from(input, 'utf8');
  if (buf.length <= maxBytes) return input;
  return buf.subarray(-maxBytes).toString('utf8');
}

export function redactSensitive(input: string): string {
  let out = input;

  out = out.replace(
    /(CODEX_API_KEY|OPENAI_API_KEY|ANTHROPIC_[A-Z0-9_]*|CLAUDE_CODE_[A-Z0-9_]*)(\s*[=:]\s*)([^\s"']+)/gi,
    (_m, key: string, sep: string) => `${key}${sep}[REDACTED]`,
  );

  out = out.replace(/Authorization:\s*Bearer\s+[^\s"']+/gi, 'Authorization: Bearer [REDACTED]');

  out = out.replace(/\b(sk-|sess-|tok-)[A-Za-z0-9._-]+\b/g, (_m, prefix: string) => {
    return `${prefix}[REDACTED]`;
  });

  return out;
}

function makeWarning(
  code: string,
  message?: unknown,
  meta?: Record<string, unknown>,
): WrapperWarning {
  return {
    code,
    message: message == null ? undefined : toStringValue(message),
    meta: normalizeMeta(meta),
  };
}

export function writeOutput(output: CodexContainerOutput): void {
  process.stdout.write(`${OUTPUT_START_MARKER}\n`);
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.stdout.write(`${OUTPUT_END_MARKER}\n`);
}

export async function readStdinWithLimit(
  input: Readable,
  maxBytes = MAX_STDIN_BYTES,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of input) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.length;
    if (total > maxBytes) {
      const err = new Error('INPUT_TOO_LARGE') as Error & {
        code?: string;
        meta?: Record<string, unknown>;
      };
      err.code = 'INPUT_TOO_LARGE';
      err.meta = { maxBytes, receivedBytes: total };
      throw err;
    }
    chunks.push(buf);
  }

  return Buffer.concat(chunks).toString('utf8');
}

export async function readContainerInput(
  input: Readable,
): Promise<CodexContainerInput> {
  const raw = await readStdinWithLimit(input, MAX_STDIN_BYTES);
  return JSON.parse(raw) as CodexContainerInput;
}

export function extractAgentMessageText(item: unknown): string {
  const content = (item as { message?: { content?: unknown } })?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const chunk of content) {
    if (typeof chunk === 'string') {
      parts.push(chunk);
      continue;
    }
    const text = (chunk as { text?: unknown })?.text;
    if (typeof text === 'string') parts.push(text);
  }

  return parts.join('');
}

function buildCodexArgs(input: CodexContainerInput, resumeId?: string): string[] {
  const args = resumeId
    ? ['exec', 'resume', resumeId, '--json', '--skip-git-repo-check']
    : ['exec', '--json', '--skip-git-repo-check'];

  if (input.sandboxMode === 'full-auto') {
    args.push('--full-auto');
  } else if (input.sandboxMode === 'danger-full-access') {
    args.push('--danger-full-access');
  }

  return args;
}

function buildCodexEnv(input: CodexContainerInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(input.env ?? {}),
    ...(input.secrets ?? {}),
  };

  if (input.model) env.CODEX_MODEL = input.model;
  if (input.systemPrompt) env.CODEX_SYSTEM_PROMPT = input.systemPrompt;
  if (input.tools) env.NANOCLAW_CODEX_TOOLS_JSON = JSON.stringify(input.tools);

  return env;
}

function getWorkingDir(input: CodexContainerInput): string {
  return input.workingDir || '/workspace/group';
}

async function runCodexAttempt(
  input: CodexContainerInput,
  opts: { spawnFn?: SpawnLike; resumeId?: string },
): Promise<AttemptResult> {
  const spawnFn = opts.spawnFn ?? (spawn as SpawnLike);
  const args = buildCodexArgs(input, opts.resumeId);
  const child = spawnFn('codex', args, {
    cwd: getWorkingDir(input),
    env: buildCodexEnv(input),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Pass the user prompt through codex stdin for both new and resumed turns.
  const promptText = typeof input.prompt === 'string' ? input.prompt : '';
  child.stdin.write(promptText);
  child.stdin.end();

  let parseErrors = 0;
  let sawThreadNotFound = false;
  let sawTurnFailed = false;
  let sawTurnCompleted = false;
  let threadId: string | null = null;
  let lastAgentMessage: string | null = null;
  const allAgentMessages: string[] = [];
  let turnFailedMessage = '';
  let stderr = '';
  const warnings: WrapperWarning[] = [];

  child.stderr.on('data', (chunk) => {
    stderr = appendTail(stderr, Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
  });

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  rl.on('line', (line) => {
    if (!line.trim()) return;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      parseErrors += 1;
      warnings.push(
        makeWarning('JSONL_PARSE_ERROR', undefined, {
          lineTail: tailBytes(line, 256),
          parseErrorCount: parseErrors,
        }),
      );
      if (parseErrors > MAX_JSONL_PARSE_ERRORS) {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore kill errors
        }
      }
      return;
    }

    const type = typeof event.type === 'string' ? event.type : '';

    if (type === 'thread.started') {
      const maybeThreadId = event.thread_id;
      if (typeof maybeThreadId === 'string' && maybeThreadId) {
        threadId = maybeThreadId;
      }
      return;
    }

    if (type === 'thread.not_found') {
      sawThreadNotFound = true;
      return;
    }

    if (type === 'item.completed') {
      const item = event.item as { type?: unknown; message?: { content?: unknown } };
      if (item && item.type === 'agent_message') {
        const text = extractAgentMessageText(item).trim();
        if (text) {
          allAgentMessages.push(text);
          lastAgentMessage = text;
        }
      }
      return;
    }

    if (type === 'turn.failed') {
      sawTurnFailed = true;
      const msg =
        (event.error as { message?: unknown } | undefined)?.message ??
        event.message ??
        'TURN_FAILED';
      turnFailedMessage = toStringValue(msg, 512) || 'TURN_FAILED';
      return;
    }

    if (type === 'turn.completed') {
      sawTurnCompleted = true;
    }
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });

  rl.close();

  if (parseErrors > MAX_JSONL_PARSE_ERRORS) {
    return {
      processExitCode: exitCode,
      sawThreadNotFound,
      sawTurnFailed,
      output: {
        status: 'error',
        result: null,
        newSessionId: threadId,
        message: 'JSONL_PARSE_ERROR',
        warnings,
      },
    };
  }

  if (!threadId) {
    warnings.push(makeWarning('THREAD_ID_MISSING'));
    if (stderr.trim()) {
      warnings.push(
        makeWarning('STDERR_TAIL', undefined, {
          stderr_tail: tailBytes(redactSensitive(stderr), STDERR_TAIL_BYTES),
        }),
      );
    }
    return {
      processExitCode: exitCode,
      sawThreadNotFound,
      sawTurnFailed,
      output: {
        status: 'error',
        result: null,
        newSessionId: null,
        message: 'THREAD_ID_MISSING',
        warnings,
      },
    };
  }

  if (sawTurnFailed || exitCode !== 0) {
    const message = turnFailedMessage || 'CODEX_TURN_FAILED';
    if (stderr.trim()) {
      warnings.push(
        makeWarning('STDERR_TAIL', undefined, {
          stderr_tail: tailBytes(redactSensitive(stderr), STDERR_TAIL_BYTES),
        }),
      );
    }

    return {
      processExitCode: exitCode,
      sawThreadNotFound,
      sawTurnFailed,
      output: {
        status: 'error',
        result: null,
        newSessionId: threadId,
        message,
        warnings,
      },
    };
  }

  if (!lastAgentMessage) {
    warnings.push(makeWarning('NO_AGENT_MESSAGE'));
    return {
      processExitCode: exitCode,
      sawThreadNotFound,
      sawTurnFailed,
      output: {
        status: 'error',
        result: null,
        newSessionId: threadId,
        message: 'NO_AGENT_MESSAGE',
        warnings,
      },
    };
  }

  const teamsMode = input.teamsMode ?? DEFAULT_TEAMS_MODE;
  const finalResult =
    teamsMode === 'wrapper-aggregate' && allAgentMessages.length > 1
      ? allAgentMessages.join('\n\n')
      : lastAgentMessage;

  if (allAgentMessages.length > 1) {
    warnings.push(
      makeWarning('TEAMS_PARITY_MODE_LOCKED', undefined, {
        mode: teamsMode,
        messageCount: allAgentMessages.length,
      }),
    );
  }

  if (!sawTurnCompleted) {
    warnings.push(makeWarning('TURN_COMPLETED_MISSING'));
  }

  return {
    processExitCode: exitCode,
    sawThreadNotFound,
      sawTurnFailed,
      output: {
        status: 'success',
        result: finalResult,
        newSessionId: threadId,
        warnings: warnings.length > 0 ? warnings : undefined,
      },
  };
}

function shouldResumeFallback(attempt: AttemptResult): boolean {
  return (
    attempt.sawThreadNotFound ||
    attempt.sawTurnFailed ||
    attempt.processExitCode !== 0
  );
}

export async function executeCodexWrapper(
  containerInput: CodexContainerInput,
  opts: { spawnFn?: SpawnLike } = {},
): Promise<CodexContainerOutput> {
  const initial = await runCodexAttempt(containerInput, {
    spawnFn: opts.spawnFn,
    resumeId: containerInput.sessionId,
  });

  if (!containerInput.sessionId || !shouldResumeFallback(initial)) {
    return initial.output;
  }

  const oldSessionId = containerInput.sessionId;
  const fresh = await runCodexAttempt(containerInput, {
    spawnFn: opts.spawnFn,
  });

  const warning = makeWarning('SESSION_RESUME_FAILED', undefined, {
    oldSessionId,
    newSessionId: fresh.output.newSessionId ?? '',
    group: containerInput.groupFolder,
  });

  fresh.output.warnings = [...(fresh.output.warnings ?? []), warning];
  return fresh.output;
}

export async function runWrapperFromStdin(
  input: Readable,
  opts: { spawnFn?: SpawnLike } = {},
): Promise<WrapperRunResult> {
  let containerInput: CodexContainerInput;
  try {
    containerInput = await readContainerInput(input);
  } catch (error) {
    const err = error as Error & { code?: string; meta?: Record<string, unknown> };
    if (err.code === 'INPUT_TOO_LARGE') {
      return {
        exitCode: 1,
        output: {
          status: 'error',
          result: null,
          message: 'INPUT_TOO_LARGE',
          warnings: [makeWarning('INPUT_TOO_LARGE', undefined, err.meta)],
        },
      };
    }

    return {
      exitCode: 1,
      output: {
        status: 'error',
        result: null,
        message: 'INPUT_JSON_PARSE_ERROR',
        warnings: [makeWarning('INPUT_JSON_PARSE_ERROR')],
      },
    };
  }

  const output = await executeCodexWrapper(containerInput, opts);
  if (
    process.env.MAP_PARTIAL_TO_SUCCESS === '1' &&
    output.status === 'partial'
  ) {
    output.status = 'success';
    output.warnings = [
      ...(output.warnings ?? []),
      makeWarning('PARTIAL_MAPPED_TO_SUCCESS'),
    ];
  }
  return {
    output,
    exitCode: output.status === 'error' ? 1 : 0,
  };
}

export async function runCodexWrapperMain(): Promise<void> {
  const result = await runWrapperFromStdin(process.stdin);
  writeOutput(result.output);
  process.exit(result.exitCode);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCodexWrapperMain().catch((err) => {
    writeOutput({
      status: 'error',
      result: null,
      message: 'WRAPPER_FATAL_ERROR',
      warnings: [
        {
          code: 'WRAPPER_FATAL_ERROR',
          message: toStringValue(err),
        },
      ],
    });
    process.exit(1);
  });
}
