import { Readable } from 'stream';

export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
export const MAX_STDIN_BYTES = 1024 * 1024; // 1MB

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
      const err = new Error('INPUT_TOO_LARGE');
      (err as Error & { code?: string; meta?: Record<string, unknown> }).code =
        'INPUT_TOO_LARGE';
      (
        err as Error & {
          code?: string;
          meta?: Record<string, unknown>;
        }
      ).meta = {
        maxBytes,
        receivedBytes: total,
      };
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

export async function runCodexWrapperSkeleton(): Promise<void> {
  try {
    await readContainerInput(process.stdin);
    writeOutput({
      status: 'error',
      result: null,
      message: 'CODEX_WRAPPER_SKELETON',
      warnings: [{ code: 'CODEX_WRAPPER_SKELETON' }],
    });
    process.exit(1);
  } catch (error) {
    const err = error as Error & {
      code?: string;
      meta?: Record<string, unknown>;
    };
    const code = err.code === 'INPUT_TOO_LARGE' ? 'INPUT_TOO_LARGE' : 'INPUT_JSON_PARSE_ERROR';
    writeOutput({
      status: 'error',
      result: null,
      message: code,
      warnings: [
        {
          code,
          meta: normalizeMeta(err.meta),
        },
      ],
    });
    process.exit(1);
  }
}
