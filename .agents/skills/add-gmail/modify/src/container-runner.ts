/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const SEED_LOCK_FILE_NAME = '.seed.lock';
const SEED_LOCK_STALE_MS = 30_000;
const SEED_LOCK_RETRY_COUNT = 10;
const SEED_LOCK_RETRY_MS = 100;
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
}

export interface ContainerOutput {
  status: 'success' | 'error' | 'partial';
  result: string | null;
  newSessionId?: string | null;
  message?: string;
  errors?: string[];
  warnings?: Array<{
    code: string;
    message?: string;
    meta?: Record<string, string>;
  }>;
  // Deprecated: kept for backwards compatibility with legacy consumers
  error?: string;
}

type CodexCredentialSource =
  | 'codex_key'
  | 'openai_key'
  | 'codex_auth_file'
  | 'none';

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const homeDir = os.homedir();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .codex/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Secrets are passed via stdin instead (see readSecrets()).
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Codex sessions directory (isolated from other groups)
  const groupCodexSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.codex',
  );
  fs.mkdirSync(groupCodexSessionsDir, { recursive: true });
  seedCodexAuthIfNeeded(group.folder);
  mounts.push({
    hostPath: groupCodexSessionsDir,
    containerPath: '/home/node/.codex',
    readonly: false,
  });

  // Gmail credentials directory (for Gmail MCP inside the container)
  const gmailDir = path.join(homeDir, '.gmail-mcp');
  if (fs.existsSync(gmailDir)) {
    mounts.push({
      hostPath: gmailDir,
      containerPath: '/home/node/.gmail-mcp',
      readonly: false, // MCP may need to refresh OAuth tokens
    });
  }

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    // Keep group-local customizations, but always seed newly added runner files
    // (for example codex-wrapper.ts) into existing group directories.
    fs.mkdirSync(groupAgentRunnerDir, { recursive: true });
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

/**
 * Read allowed secrets from .env for passing to the container via stdin.
 * Secrets are never written to disk or mounted as files.
 */
function readSecrets(): Record<string, string> {
  return readEnvFile(['CODEX_API_KEY', 'OPENAI_API_KEY']);
}

function resolveCodexCredentialSource(
  groupFolder: string,
): CodexCredentialSource {
  const secrets = readSecrets();
  if (secrets.CODEX_API_KEY) return 'codex_key';
  if (secrets.OPENAI_API_KEY) return 'openai_key';

  const authPath = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.codex',
    'auth.json',
  );
  if (fs.existsSync(authPath)) return 'codex_auth_file';
  return 'none';
}

function sleepMs(ms: number): void {
  Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

function acquireSeedLock(lockPath: string): number | null {
  for (let attempt = 0; attempt <= SEED_LOCK_RETRY_COUNT; attempt += 1) {
    try {
      return fs.openSync(lockPath, 'wx', 0o600);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') return null;

      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > SEED_LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        // Lock disappeared or became unreadable between attempts.
      }

      if (attempt < SEED_LOCK_RETRY_COUNT) {
        sleepMs(SEED_LOCK_RETRY_MS);
      }
    }
  }

  return null;
}

function releaseSeedLock(lockPath: string, fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    // Ignore close errors.
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Ignore unlink errors.
  }
}

function validateSeedSource(sourcePath: string, sourceRoot: string): boolean {
  const sourceResolved = path.resolve(sourcePath);
  if (
    sourceResolved !== sourceRoot &&
    !sourceResolved.startsWith(`${sourceRoot}${path.sep}`)
  ) {
    return false;
  }

  try {
    const st = fs.lstatSync(sourceResolved);
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function seedFileIfMissing(
  sourcePath: string,
  destPath: string,
  sourceRoot: string,
): boolean {
  if (!validateSeedSource(sourcePath, sourceRoot)) return false;
  if (fs.existsSync(destPath)) return false;

  const tmpPath = `${destPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    const content = fs.readFileSync(sourcePath);
    fs.writeFileSync(tmpPath, content, { mode: 0o600 });
    fs.renameSync(tmpPath, destPath);
    fs.chmodSync(destPath, 0o600);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore tmp cleanup failures.
    }
    return false;
  }
}

function seedCodexAuthIfNeeded(groupFolder: string): void {
  const hostCodexDir = path.resolve(process.env.HOME || os.homedir(), '.codex');
  const hostAuthPath = path.join(hostCodexDir, 'auth.json');
  const groupCodexDir = path.join(DATA_DIR, 'sessions', groupFolder, '.codex');
  const groupAuthPath = path.join(groupCodexDir, 'auth.json');

  if (!fs.existsSync(hostAuthPath) || fs.existsSync(groupAuthPath)) return;

  const lockPath = path.join(groupCodexDir, SEED_LOCK_FILE_NAME);
  const lockFd = acquireSeedLock(lockPath);
  if (lockFd == null) {
    logger.warn(
      { group: groupFolder },
      'CODEX_AUTH_SEED_FAILED: unable to acquire seed lock',
    );
    return;
  }

  try {
    if (fs.existsSync(groupAuthPath)) return;

    const copiedAuth = seedFileIfMissing(
      hostAuthPath,
      groupAuthPath,
      hostCodexDir,
    );
    if (!copiedAuth) {
      logger.warn(
        { group: groupFolder },
        'CODEX_AUTH_SEED_FAILED: auth.json unavailable or invalid',
      );
      return;
    }

    const hostConfigPath = path.join(hostCodexDir, 'config.toml');
    const groupConfigPath = path.join(groupCodexDir, 'config.toml');
    if (fs.existsSync(hostConfigPath)) {
      seedFileIfMissing(hostConfigPath, groupConfigPath, hostCodexDir);
    }

    logger.info({ group: groupFolder }, 'CODEX_AUTH_SEEDED');
  } finally {
    releaseSeedLock(lockPath, lockFd);
  }
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  input: ContainerInput,
  secrets: Record<string, string>,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);
  args.push('-e', `NANOCLAW_CHAT_JID=${input.chatJid}`);
  args.push('-e', `NANOCLAW_GROUP_FOLDER=${input.groupFolder}`);
  args.push('-e', `NANOCLAW_IS_MAIN=${input.isMain ? '1' : '0'}`);
  if (input.assistantName) {
    args.push('-e', `NANOCLAW_ASSISTANT_NAME=${input.assistantName}`);
  }

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  for (const [key, value] of Object.entries(secrets)) {
    args.push('-e', `${key}=${value}`);
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

function normalizeContainerOutput(raw: unknown): ContainerOutput {
  const parsed = raw as Partial<ContainerOutput>;
  const status =
    parsed.status === 'success' ||
    parsed.status === 'error' ||
    parsed.status === 'partial'
      ? parsed.status
      : 'error';

  const result =
    typeof parsed.result === 'string' || parsed.result === null
      ? parsed.result
      : parsed.result == null
        ? null
        : JSON.stringify(parsed.result);

  const message =
    typeof parsed.message === 'string'
      ? parsed.message
      : typeof parsed.error === 'string'
        ? parsed.error
        : undefined;

  const errors = Array.isArray(parsed.errors)
    ? parsed.errors.map((e) => String(e))
    : undefined;

  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.map((w) => ({
        code: String((w as { code?: unknown }).code ?? ''),
        message:
          typeof (w as { message?: unknown }).message === 'string'
            ? (w as { message?: string }).message
            : undefined,
        meta:
          typeof (w as { meta?: unknown }).meta === 'object' &&
          (w as { meta?: unknown }).meta
            ? Object.fromEntries(
                Object.entries(
                  (w as { meta: Record<string, unknown> }).meta,
                ).map(([k, v]) => [k, String(v)]),
              )
            : undefined,
      }))
    : undefined;

  const newSessionId =
    typeof parsed.newSessionId === 'string' || parsed.newSessionId === null
      ? parsed.newSessionId
      : undefined;

  const normalized: ContainerOutput = {
    status,
    result,
    newSessionId,
    message,
    errors,
    warnings,
    error: message,
  };

  if (normalized.status === 'error' && !normalized.message) {
    normalized.message = 'UNKNOWN_CONTAINER_ERROR';
    normalized.error = normalized.message;
  }

  return normalized;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const credentialSource = resolveCodexCredentialSource(group.folder);

  if (credentialSource === 'none') {
    logger.error(
      { group: group.name, credentialSource },
      'CODEX_CREDENTIAL_MISSING',
    );
    return {
      status: 'error',
      result: null,
      message: 'CODEX_CREDENTIAL_MISSING',
      error: 'CODEX_CREDENTIAL_MISSING',
      warnings: [
        {
          code: 'CODEX_CREDENTIAL_MISSING',
          meta: { group: group.folder },
        },
      ],
    };
  }

  const secrets = readSecrets();
  const containerArgs = buildContainerArgs(
    mounts,
    containerName,
    input,
    secrets,
  );

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
      credentialSource,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Pass secrets via stdin (never written to disk or mounted as files)
    input.secrets = readSecrets();
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();
    // Remove secrets from input so they don't appear in logs
    delete input.secrets;

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed = normalizeContainerOutput(JSON.parse(jsonStr));
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          message: `Container timed out after ${configTimeout}ms`,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          message: `Container exited with code ${code}: ${stderr.slice(-200)}`,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output = normalizeContainerOutput(JSON.parse(jsonLine));

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          message: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        message: `Container spawn error: ${err.message}`,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
