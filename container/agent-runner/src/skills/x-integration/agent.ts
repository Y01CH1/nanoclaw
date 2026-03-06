import fs from 'fs';
import path from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const IPC_DIR = '/workspace/ipc';
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESULTS_DIR = path.join(IPC_DIR, 'x_results');

const groupFolder = process.env.NANOCLAW_GROUP_FOLDER || '';
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;

  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

async function waitForResult(
  requestId: string,
  maxWait = 60_000,
): Promise<{ success: boolean; message: string }> {
  const resultFile = path.join(RESULTS_DIR, `${requestId}.json`);
  const pollInterval = 1_000;
  let elapsed = 0;

  while (elapsed < maxWait) {
    if (fs.existsSync(resultFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return result;
      } catch (err) {
        return {
          success: false,
          message: `Failed to read result: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }

  return { success: false, message: 'Request timed out' };
}

async function runXRequest(
  type: string,
  payload: Record<string, string>,
): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
}> {
  if (!isMain) {
    return {
      content: [
        {
          type: 'text',
          text: 'Only the main group can use X integration tools.',
        },
      ],
      isError: true,
    };
  }

  const requestId = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  writeIpcFile(TASKS_DIR, {
    type,
    requestId,
    groupFolder,
    timestamp: new Date().toISOString(),
    ...payload,
  });

  const result = await waitForResult(requestId);
  return {
    content: [{ type: 'text', text: result.message }],
    ...(result.success ? {} : { isError: true as const }),
  };
}

const server = new McpServer({
  name: 'x',
  version: '1.0.0',
});

server.tool(
  'x_post',
  'Post a tweet to X (Twitter). Main group only.',
  {
    content: z
      .string()
      .max(280)
      .describe('The tweet content to post (max 280 characters)'),
  },
  async (args) => runXRequest('x_post', { content: args.content }),
);

server.tool(
  'x_like',
  'Like a tweet on X (Twitter). Main group only.',
  {
    tweet_url: z
      .string()
      .describe(
        'The tweet URL (for example https://x.com/user/status/123) or tweet ID',
      ),
  },
  async (args) => runXRequest('x_like', { tweetUrl: args.tweet_url }),
);

server.tool(
  'x_reply',
  'Reply to a tweet on X (Twitter). Main group only.',
  {
    tweet_url: z
      .string()
      .describe(
        'The tweet URL (for example https://x.com/user/status/123) or tweet ID',
      ),
    content: z
      .string()
      .max(280)
      .describe('The reply content (max 280 characters)'),
  },
  async (args) =>
    runXRequest('x_reply', {
      tweetUrl: args.tweet_url,
      content: args.content,
    }),
);

server.tool(
  'x_retweet',
  'Retweet a tweet on X (Twitter). Main group only.',
  {
    tweet_url: z
      .string()
      .describe(
        'The tweet URL (for example https://x.com/user/status/123) or tweet ID',
      ),
  },
  async (args) => runXRequest('x_retweet', { tweetUrl: args.tweet_url }),
);

server.tool(
  'x_quote',
  'Quote tweet on X (Twitter). Main group only.',
  {
    tweet_url: z
      .string()
      .describe(
        'The tweet URL (for example https://x.com/user/status/123) or tweet ID',
      ),
    comment: z
      .string()
      .max(280)
      .describe('Your comment for the quote tweet (max 280 characters)'),
  },
  async (args) =>
    runXRequest('x_quote', {
      tweetUrl: args.tweet_url,
      comment: args.comment,
    }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
