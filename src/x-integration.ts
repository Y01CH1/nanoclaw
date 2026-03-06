import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

interface SkillResult {
  success: boolean;
  message: string;
  data?: unknown;
}

async function runScript(script: string, args: object): Promise<SkillResult> {
  const scriptPath = path.join(
    process.cwd(),
    '.agents',
    'skills',
    'x-integration',
    'scripts',
    `${script}.ts`,
  );

  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', scriptPath], {
      cwd: process.cwd(),
      env: { ...process.env, NANOCLAW_ROOT: process.cwd() },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stdin.write(JSON.stringify(args));
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ success: false, message: 'Script timed out (120s)' });
    }, 120_000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({
          success: false,
          message: `Script exited with code: ${code}`,
        });
        return;
      }

      try {
        const lines = stdout.trim().split('\n');
        resolve(JSON.parse(lines[lines.length - 1]));
      } catch {
        resolve({
          success: false,
          message: `Failed to parse output: ${stdout.slice(0, 200)}`,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, message: `Failed to spawn: ${err.message}` });
    });
  });
}

function writeResult(
  dataDir: string,
  sourceGroup: string,
  requestId: string,
  result: SkillResult,
): void {
  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'x_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDir, `${requestId}.json`),
    JSON.stringify(result),
  );
}

export async function handleXIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  const type = data.type as string;

  if (!type?.startsWith('x_')) {
    return false;
  }

  if (!isMain) {
    logger.warn({ sourceGroup, type }, 'X integration blocked: not main group');
    return true;
  }

  const requestId = data.requestId as string;
  if (!requestId) {
    logger.warn({ type }, 'X integration blocked: missing requestId');
    return true;
  }

  logger.info({ type, requestId }, 'Processing X request');

  let result: SkillResult;

  switch (type) {
    case 'x_post':
      result = data.content
        ? await runScript('post', { content: data.content })
        : { success: false, message: 'Missing content' };
      break;
    case 'x_like':
      result = data.tweetUrl
        ? await runScript('like', { tweetUrl: data.tweetUrl })
        : { success: false, message: 'Missing tweetUrl' };
      break;
    case 'x_reply':
      result =
        data.tweetUrl && data.content
          ? await runScript('reply', {
              tweetUrl: data.tweetUrl,
              content: data.content,
            })
          : { success: false, message: 'Missing tweetUrl or content' };
      break;
    case 'x_retweet':
      result = data.tweetUrl
        ? await runScript('retweet', { tweetUrl: data.tweetUrl })
        : { success: false, message: 'Missing tweetUrl' };
      break;
    case 'x_quote':
      result =
        data.tweetUrl && data.comment
          ? await runScript('quote', {
              tweetUrl: data.tweetUrl,
              comment: data.comment,
            })
          : { success: false, message: 'Missing tweetUrl or comment' };
      break;
    default:
      return false;
  }

  writeResult(dataDir, sourceGroup, requestId, result);
  if (result.success) {
    logger.info({ type, requestId }, 'X request completed');
  } else {
    logger.error(
      { type, requestId, message: result.message },
      'X request failed',
    );
  }
  return true;
}
