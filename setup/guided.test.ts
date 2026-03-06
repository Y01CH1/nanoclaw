import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  normalizeChannelJid,
  parseGroupList,
  parseLatestStatus,
  runGuidedSetup,
  sanitizeFolderSlug,
  upsertEnvContent,
  type GuidedDeps,
  type Prompter,
} from './guided.js';

function createTempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-guided-'));
}

function writeProjectFile(
  projectRoot: string,
  relativePath: string,
  content = '',
): void {
  const target = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function createPrompter(answers: {
  select?: string[];
  multiselect?: string[][];
  input?: string[];
  confirm?: boolean[];
}): Prompter {
  return {
    select: vi.fn(async () => answers.select?.shift() ?? ''),
    multiselect: vi.fn(async () => answers.multiselect?.shift() ?? []),
    input: vi.fn(async () => answers.input?.shift() ?? ''),
    confirm: vi.fn(async () => answers.confirm?.shift() ?? false),
    note: vi.fn(),
  };
}

function createDeps(
  projectRoot: string,
  prompter: Prompter,
  handlers: Record<
    string,
    (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
  >,
): GuidedDeps {
  return {
    projectRoot,
    prompter,
    runCommand: vi.fn(async (command, args) => {
      const key = `${command} ${args.join(' ')}`;
      const handler = handlers[key];
      if (!handler) {
        throw new Error(`Unexpected command: ${key}`);
      }
      return handler(args);
    }),
  };
}

describe('guided setup helpers', () => {
  it('parses the latest setup status block', () => {
    const status = parseLatestStatus(`
noise
=== NANOCLAW SETUP: CHECK_ENVIRONMENT ===
STATUS: success
DOCKER: running
=== END ===
`);

    expect(status).not.toBeNull();
    expect(status?.step).toBe('CHECK_ENVIRONMENT');
    expect(status?.fields.DOCKER).toBe('running');
  });

  it('parses synced WhatsApp group list output', () => {
    expect(parseGroupList('123@g.us|Family\n234@g.us|Work')).toEqual([
      { jid: '123@g.us', name: 'Family' },
      { jid: '234@g.us', name: 'Work' },
    ]);
  });

  it('updates env content without dropping existing entries', () => {
    const content = upsertEnvContent('EXISTING=yes\nASSISTANT_NAME=Andy\n', {
      ASSISTANT_NAME: 'Nova',
      TELEGRAM_BOT_TOKEN: '123:abc',
    });

    expect(content).toContain('EXISTING=yes');
    expect(content).toContain('ASSISTANT_NAME=Nova');
    expect(content).toContain('TELEGRAM_BOT_TOKEN=123:abc');
  });

  it('normalizes channel ids and folder slugs', () => {
    expect(normalizeChannelJid('telegram', '123')).toBe('tg:123');
    expect(normalizeChannelJid('discord', 'dc:456')).toBe('dc:456');
    expect(sanitizeFolderSlug('Family Chat!!')).toBe('family-chat');
  });
});

describe('runGuidedSetup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('orchestrates a WhatsApp main chat setup', async () => {
    const projectRoot = createTempProject();
    writeProjectFile(projectRoot, '.env.example', 'ASSISTANT_NAME=Andy\n');

    const prompter = createPrompter({
      input: ['Andy', '@Andy', 'WhatsApp main'],
      multiselect: [['WhatsApp']],
      select: ['QR code in browser', 'Self-chat'],
      confirm: [false],
    });

    const deps = createDeps(projectRoot, prompter, {
      'npx tsx setup/index.ts --step environment --': async () => ({
        code: 0,
        stdout: `=== NANOCLAW SETUP: CHECK_ENVIRONMENT ===
PLATFORM: linux
IS_WSL: false
IS_HEADLESS: false
DOCKER: running
STATUS: success
=== END ===
`,
        stderr: '',
      }),
      'npx tsx setup/index.ts --step container -- --runtime docker': async () => ({
        code: 0,
        stdout: `=== NANOCLAW SETUP: SETUP_CONTAINER ===
STATUS: success
=== END ===
`,
        stderr: '',
      }),
      'npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp': async () => {
        writeProjectFile(projectRoot, 'src/channels/whatsapp.ts', '');
        writeProjectFile(projectRoot, 'src/whatsapp-auth.ts', '');
        writeProjectFile(projectRoot, 'setup/whatsapp-auth.ts', '');
        return { code: 0, stdout: '{"success":true}', stderr: '' };
      },
      'npx tsx setup/index.ts --step whatsapp-auth -- --method qr-browser': async () => {
        writeProjectFile(
          projectRoot,
          'store/auth/creds.json',
          JSON.stringify({ me: { id: '15551234567:1@s.whatsapp.net' } }),
        );
        return {
          code: 0,
          stdout: `=== NANOCLAW SETUP: AUTH_WHATSAPP ===
STATUS: success
=== END ===
`,
          stderr: '',
        };
      },
      'npx tsx setup/index.ts --step register -- --jid 15551234567@s.whatsapp.net --name WhatsApp main --trigger @Andy --folder whatsapp_main --channel whatsapp --assistant-name Andy --is-main --no-trigger-required': async () => ({
        code: 0,
        stdout: `=== NANOCLAW SETUP: REGISTER_CHANNEL ===
STATUS: success
=== END ===
`,
        stderr: '',
      }),
      'npx tsx setup/index.ts --step mounts -- --empty': async () => ({
        code: 0,
        stdout: `=== NANOCLAW SETUP: CONFIGURE_MOUNTS ===
STATUS: success
=== END ===
`,
        stderr: '',
      }),
      'npx tsx setup/index.ts --step service --': async () => ({
        code: 0,
        stdout: `=== NANOCLAW SETUP: SETUP_SERVICE ===
STATUS: success
=== END ===
`,
        stderr: '',
      }),
      'npx tsx setup/index.ts --step verify --': async () => ({
        code: 0,
        stdout: `=== NANOCLAW SETUP: VERIFY ===
STATUS: success
=== END ===
`,
        stderr: '',
      }),
    });

    await runGuidedSetup(deps);

    const commands = (deps.runCommand as any).mock.calls.map(
      ([command, args]: [string, string[]]) => `${command} ${args.join(' ')}`,
    );
    expect(commands).toContain(
      'npx tsx setup/index.ts --step whatsapp-auth -- --method qr-browser',
    );
    expect(commands).toContain(
      'npx tsx setup/index.ts --step register -- --jid 15551234567@s.whatsapp.net --name WhatsApp main --trigger @Andy --folder whatsapp_main --channel whatsapp --assistant-name Andy --is-main --no-trigger-required',
    );
  });

  it('writes token-based channel credentials and registers telegram', async () => {
    const projectRoot = createTempProject();
    writeProjectFile(projectRoot, '.env.example', 'ASSISTANT_NAME=Andy\n');

    const prompter = createPrompter({
      input: ['Nova', '@Nova', '123:abc', '123456', 'Control chat'],
      multiselect: [['Telegram']],
      confirm: [false],
    });

    const deps = createDeps(projectRoot, prompter, {
      'npx tsx setup/index.ts --step environment --': async () => ({
        code: 0,
        stdout: `=== NANOCLAW SETUP: CHECK_ENVIRONMENT ===
PLATFORM: linux
IS_WSL: false
IS_HEADLESS: false
DOCKER: running
STATUS: success
=== END ===
`,
        stderr: '',
      }),
      'npx tsx setup/index.ts --step container -- --runtime docker': async () => ({
        code: 0,
        stdout: `=== NANOCLAW SETUP: SETUP_CONTAINER ===
STATUS: success
=== END ===
`,
        stderr: '',
      }),
      'npx tsx scripts/apply-skill.ts .claude/skills/add-telegram': async () => {
        writeProjectFile(projectRoot, 'src/channels/telegram.ts', '');
        return { code: 0, stdout: '{"success":true}', stderr: '' };
      },
      'npx tsx setup/index.ts --step register -- --jid tg:123456 --name Control chat --trigger @Nova --folder telegram_main --channel telegram --assistant-name Nova --is-main --no-trigger-required': async () => ({
        code: 0,
        stdout: `=== NANOCLAW SETUP: REGISTER_CHANNEL ===
STATUS: success
=== END ===
`,
        stderr: '',
      }),
      'npx tsx setup/index.ts --step mounts -- --empty': async () => ({
        code: 0,
        stdout: `=== NANOCLAW SETUP: CONFIGURE_MOUNTS ===
STATUS: success
=== END ===
`,
        stderr: '',
      }),
      'npx tsx setup/index.ts --step service --': async () => ({
        code: 0,
        stdout: `=== NANOCLAW SETUP: SETUP_SERVICE ===
STATUS: success
=== END ===
`,
        stderr: '',
      }),
      'npx tsx setup/index.ts --step verify --': async () => ({
        code: 0,
        stdout: `=== NANOCLAW SETUP: VERIFY ===
STATUS: success
=== END ===
`,
        stderr: '',
      }),
    });

    await runGuidedSetup(deps);

    const envContent = fs.readFileSync(path.join(projectRoot, '.env'), 'utf-8');
    expect(envContent).toContain('TELEGRAM_BOT_TOKEN=123:abc');
    expect(envContent).toContain('ASSISTANT_NAME=Andy');
    expect(fs.existsSync(path.join(projectRoot, 'data/env/env'))).toBe(true);
  });
});
