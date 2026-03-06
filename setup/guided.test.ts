import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getChannelCreationGuide,
  getChannelRegistrationGuide,
  isAppleContainerConverted,
  normalizeChannelJid,
  parseGroupList,
  parseLatestStatus,
  readProjectEnvValues,
  promptRequiredInput,
  runGuidedSetup,
  sanitizeFolderSlug,
  upsertEnvContent,
  writeGmailOAuthKeys,
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

function seedGmailToolOnlyTargets(projectRoot: string): void {
  const repoRoot = process.cwd();
  writeProjectFile(
    projectRoot,
    'src/container-runner.ts',
    fs.readFileSync(path.join(repoRoot, 'src', 'container-runner.ts'), 'utf-8'),
  );
  writeProjectFile(
    projectRoot,
    'container/agent-runner/src/index.ts',
    fs.readFileSync(
      path.join(repoRoot, 'container', 'agent-runner', 'src', 'index.ts'),
      'utf-8',
    ),
  );
}

function seedGmailChannelTargets(projectRoot: string): void {
  seedGmailToolOnlyTargets(projectRoot);
  writeProjectFile(projectRoot, 'src/channels/gmail.ts', 'export {};\n');
  writeProjectFile(projectRoot, 'src/channels/gmail.test.ts', 'export {};\n');
  writeProjectFile(
    projectRoot,
    'src/channels/index.ts',
    "import './gmail.js';\n// gmail\n",
  );
}

function markGmailToolOnlyConfigured(projectRoot: string): void {
  writeProjectFile(
    projectRoot,
    '.nanoclaw/state.yaml',
    `skills_system_version: "1"
core_version: "1.2.6"
applied_skills:
  - name: gmail
    version: "1.0.0"
    applied_at: "2026-03-06T00:00:00.000Z"
    file_hashes: {}
    structured_outcomes:
      mode: tool-only
`,
  );
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
      TELEGRAM_BOT_TOKEN: '123456:telegram_token_value_1234567890',
    });

    expect(content).toContain('EXISTING=yes');
    expect(content).toContain('ASSISTANT_NAME=Nova');
    expect(content).toContain('TELEGRAM_BOT_TOKEN=123456:telegram_token_value_1234567890');
  });

  it('reads env values from the target project root', () => {
    const projectRoot = createTempProject();
    writeProjectFile(
      projectRoot,
      '.env',
      'ASSISTANT_NAME=Nova\nTELEGRAM_BOT_TOKEN=123456:telegram_token_value_1234567890\n',
    );

    expect(
      readProjectEnvValues(projectRoot, ['ASSISTANT_NAME', 'TELEGRAM_BOT_TOKEN']),
    ).toEqual({
      ASSISTANT_NAME: 'Nova',
      TELEGRAM_BOT_TOKEN: '123456:telegram_token_value_1234567890',
    });
  });

  it('exposes detailed token-channel creation and registration guides', () => {
    expect(getChannelCreationGuide('telegram').join(' ')).toContain(
      '@BotFather',
    );
    expect(getChannelCreationGuide('slack').join(' ')).toContain(
      'Socket Mode',
    );
    expect(getChannelRegistrationGuide('discord').join(' ')).toContain(
      'Developer Mode',
    );
  });

  it('normalizes channel ids and folder slugs', () => {
    expect(normalizeChannelJid('telegram', '123')).toBe('tg:123');
    expect(normalizeChannelJid('discord', 'dc:456')).toBe('dc:456');
    expect(sanitizeFolderSlug('Family Chat!!')).toBe('family-chat');
  });

  it('writes Gmail OAuth keys from JSON or file path', () => {
    const projectRoot = createTempProject();
    const sourcePath = path.join(projectRoot, 'oauth.json');
    fs.writeFileSync(sourcePath, '{"installed":{"client_id":"abc"}}');

    const fileTarget = path.join(projectRoot, 'gmail-file');
    writeGmailOAuthKeys(fileTarget, { type: 'path', value: sourcePath });
    expect(
      fs.existsSync(path.join(fileTarget, 'gcp-oauth.keys.json')),
    ).toBe(true);

    const jsonTarget = path.join(projectRoot, 'gmail-json');
    writeGmailOAuthKeys(jsonTarget, {
      type: 'json',
      value: '{"installed":{"client_id":"xyz"}}',
    });
    expect(
      fs.readFileSync(
        path.join(jsonTarget, 'gcp-oauth.keys.json'),
        'utf-8',
      ),
    ).toContain('"client_id": "xyz"');
  });

  it('detects whether Apple Container conversion has been applied', () => {
    const projectRoot = createTempProject();
    writeProjectFile(
      projectRoot,
      'src/container-runtime.ts',
      "export const CONTAINER_RUNTIME_BIN = 'container';\n",
    );

    expect(isAppleContainerConverted(projectRoot)).toBe(true);
    writeProjectFile(
      projectRoot,
      'src/container-runtime.ts',
      "export const CONTAINER_RUNTIME_BIN = 'docker';\n",
    );
    expect(isAppleContainerConverted(projectRoot)).toBe(false);
  });

  it('re-prompts until a required value is provided', async () => {
    const prompter = createPrompter({
      input: ['', 'value'],
    });

    const value = await promptRequiredInput(prompter, 'Enter token');

    expect(value).toBe('value');
    expect((prompter.note as any).mock.calls[0][0]).toContain('is required');
  });

  it('re-prompts token and channel id inputs until they match the expected format', async () => {
    const projectRoot = createTempProject();
    writeProjectFile(projectRoot, '.env.example', 'ASSISTANT_NAME=Andy\n');

    const prompter = createPrompter({
      input: ['Andy', '@Andy', 'bad-token', '123456:telegram_token_value_1234567890_valid_token_value_123456', 'not-an-id', '123456', 'Control chat'],
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
NODE: installed
NPM: installed
BUILD_TOOLS: ready
HOMEBREW: not_found
APT_GET: installed
DNF: not_found
YUM: not_found
APPLE_CONTAINER: not_found
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
      'npx tsx scripts/apply-skill.ts .agents/skills/add-telegram': async () => {
        writeProjectFile(projectRoot, 'src/channels/telegram.ts', '');
        return { code: 0, stdout: '{"success":true}', stderr: '' };
      },
      'npx tsx setup/index.ts --step register -- --jid tg:123456 --name Control chat --trigger @Andy --folder telegram_main --channel telegram --assistant-name Andy --is-main --no-trigger-required': async () => ({
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

    expect((prompter.note as any).mock.calls.some(([message]: [string]) =>
      message.includes('bot token from @BotFather'),
    )).toBe(true);
    expect((prompter.note as any).mock.calls.some(([message]: [string]) =>
      message.includes('Telegram chat IDs are numeric'),
    )).toBe(true);
  });

  it('re-prompts until at least one channel is selected', async () => {
    const projectRoot = createTempProject();
    writeProjectFile(projectRoot, '.env.example', 'ASSISTANT_NAME=Andy\n');

    const prompter = createPrompter({
      input: ['Andy', '@Andy', '123456:telegram_token_value_1234567890', '123456', 'Control chat'],
      multiselect: [[], ['Telegram']],
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
      'npx tsx scripts/apply-skill.ts .agents/skills/add-telegram': async () => {
        writeProjectFile(projectRoot, 'src/channels/telegram.ts', '');
        return { code: 0, stdout: '{"success":true}', stderr: '' };
      },
      'npx tsx setup/index.ts --step register -- --jid tg:123456 --name Control chat --trigger @Andy --folder telegram_main --channel telegram --assistant-name Andy --is-main --no-trigger-required': async () => ({
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

    expect((prompter.multiselect as any).mock.calls).toHaveLength(2);
    expect((prompter.note as any).mock.calls.some(([message]: [string]) =>
      message.includes('Select at least one messaging channel'),
    )).toBe(true);
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
      'npx tsx scripts/apply-skill.ts .agents/skills/add-whatsapp': async () => {
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
      input: ['Nova', '@Nova', '123456:telegram_token_value_1234567890', '123456', 'Control chat'],
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
      'npx tsx scripts/apply-skill.ts .agents/skills/add-telegram': async () => {
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
    expect(envContent).toContain('TELEGRAM_BOT_TOKEN=123456:telegram_token_value_1234567890');
    expect(envContent).toContain('ASSISTANT_NAME=Andy');
    expect(fs.existsSync(path.join(projectRoot, 'data/env/env'))).toBe(true);
  });

  it('reuses existing token credentials without prompting for replacement', async () => {
    const projectRoot = createTempProject();
    writeProjectFile(
      projectRoot,
      '.env',
      'TELEGRAM_BOT_TOKEN=123456:telegram_token_value_1234567890\nASSISTANT_NAME=Andy\n',
    );

    const prompter = createPrompter({
      input: ['Andy', '@Andy', '123456', 'Control chat'],
      multiselect: [['Telegram']],
      select: ['No'],
      confirm: [true, false],
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
      'npx tsx scripts/apply-skill.ts .agents/skills/add-telegram': async () => {
        writeProjectFile(projectRoot, 'src/channels/telegram.ts', '');
        return { code: 0, stdout: '{"success":true}', stderr: '' };
      },
      'npx tsx setup/index.ts --step register -- --jid tg:123456 --name Control chat --trigger @Andy --folder telegram_main --channel telegram --assistant-name Andy --is-main --no-trigger-required': async () => ({
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

    expect(fs.existsSync(path.join(projectRoot, 'data/env/env'))).toBe(true);
    expect((prompter.input as any).mock.calls).toHaveLength(4);
  });

  it('patches Gmail tool-only mode without adding a channel', async () => {
    const projectRoot = createTempProject();
    const fakeHome = path.join(projectRoot, 'home');
    writeProjectFile(projectRoot, '.env.example', 'ASSISTANT_NAME=Andy\n');
    seedGmailToolOnlyTargets(projectRoot);
    writeProjectFile(projectRoot, 'data/sessions/main/agent-runner-src/index.ts', '// stale');
    const oauthSource = path.join(projectRoot, 'gmail-oauth.json');
    fs.writeFileSync(oauthSource, '{"installed":{"client_id":"abc"}}');
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    const prompter = createPrompter({
      input: ['Andy', '@Andy', 'WhatsApp main', oauthSource],
      multiselect: [['WhatsApp']],
      select: ['QR code in browser', 'Self-chat', 'Tool-only', 'File path'],
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
      'npx tsx scripts/apply-skill.ts .agents/skills/add-whatsapp': async () => {
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
      'npx -y @gongrzhe/server-gmail-autoauth-mcp auth': async () => ({
        code: 0,
        stdout: 'gmail auth ok',
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

    expect(
      fs.existsSync(path.join(fakeHome, '.gmail-mcp', 'gcp-oauth.keys.json')),
    ).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, 'src/channels/gmail.ts'))).toBe(
      false,
    );
    expect(
      fs.readFileSync(
        path.join(projectRoot, 'container/agent-runner/src/index.ts'),
        'utf-8',
      ),
    ).toContain('@gongrzhe/server-gmail-autoauth-mcp');
    expect(
      fs.readFileSync(path.join(projectRoot, '.nanoclaw/state.yaml'), 'utf-8'),
    ).toContain('mode: tool-only');
    expect(
      fs.existsSync(path.join(projectRoot, 'data/sessions/main/agent-runner-src')),
    ).toBe(false);

    const commands = (deps.runCommand as any).mock.calls.map(
      ([command, args]: [string, string[]]) => `${command} ${args.join(' ')}`,
    );
    expect(commands).not.toContain(
      'npx tsx scripts/apply-skill.ts .agents/skills/add-gmail',
    );
    expect(
      commands.filter(
        (command: string) =>
          command === 'npx tsx setup/index.ts --step container -- --runtime docker',
      ),
    ).toHaveLength(2);
  });

  it('applies and authorizes Gmail channel mode', async () => {
    const projectRoot = createTempProject();
    const fakeHome = path.join(projectRoot, 'home');
    writeProjectFile(projectRoot, '.env.example', 'ASSISTANT_NAME=Andy\n');
    seedGmailToolOnlyTargets(projectRoot);
    writeProjectFile(projectRoot, 'groups/main/AGENTS.md', '## Formatting\n');
    writeProjectFile(projectRoot, 'data/sessions/main/agent-runner-src/index.ts', '// stale');
    const oauthSource = path.join(projectRoot, 'gmail-oauth.json');
    fs.writeFileSync(oauthSource, '{"installed":{"client_id":"abc"}}');
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    const prompter = createPrompter({
      input: ['Andy', '@Andy', 'WhatsApp main', oauthSource],
      multiselect: [['WhatsApp']],
      select: ['QR code in browser', 'Self-chat', 'Email channel', 'File path'],
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
      'npx tsx scripts/apply-skill.ts .agents/skills/add-whatsapp': async () => {
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
      'npx tsx scripts/apply-skill.ts .agents/skills/add-gmail': async () => {
        writeProjectFile(projectRoot, 'src/channels/gmail.ts', '');
        return { code: 0, stdout: '{"success":true}', stderr: '' };
      },
      'npx -y @gongrzhe/server-gmail-autoauth-mcp auth': async () => ({
        code: 0,
        stdout: 'gmail auth ok',
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

    expect(
      fs.existsSync(path.join(fakeHome, '.gmail-mcp', 'gcp-oauth.keys.json')),
    ).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, 'src/channels/gmail.ts'))).toBe(
      true,
    );
    expect(
      fs.readFileSync(path.join(projectRoot, 'groups/main/AGENTS.md'), 'utf-8'),
    ).toContain('## Email Notifications');
    expect(
      fs.existsSync(path.join(projectRoot, 'data/sessions/main/agent-runner-src')),
    ).toBe(false);

    const commands = (deps.runCommand as any).mock.calls.map(
      ([command, args]: [string, string[]]) => `${command} ${args.join(' ')}`,
    );
    expect(commands).not.toContain(
      'npx tsx scripts/apply-skill.ts .agents/skills/add-gmail',
    );
    expect(
      commands.filter(
        (command: string) =>
          command === 'npx tsx setup/index.ts --step container -- --runtime docker',
      ),
    ).toHaveLength(2);
  });

  it('reuses existing Gmail authorization when available', async () => {
    const projectRoot = createTempProject();
    const fakeHome = path.join(projectRoot, 'home');
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    writeProjectFile(projectRoot, '.env.example', 'ASSISTANT_NAME=Andy\n');
    seedGmailToolOnlyTargets(projectRoot);
    writeProjectFile(
      fakeHome,
      '.gmail-mcp/gcp-oauth.keys.json',
      '{"installed":{"client_id":"abc"}}',
    );
    writeProjectFile(
      fakeHome,
      '.gmail-mcp/credentials.json',
      '{"refresh_token":"tok"}',
    );

    const prompter = createPrompter({
      input: ['Andy', '@Andy', 'WhatsApp main'],
      multiselect: [['WhatsApp']],
      select: ['QR code in browser', 'Self-chat', 'Tool-only'],
      confirm: [true, false],
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
      'npx tsx scripts/apply-skill.ts .agents/skills/add-whatsapp': async () => {
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
    expect(commands).not.toContain('npx -y @gongrzhe/server-gmail-autoauth-mcp auth');
    expect(commands).not.toContain(
      'npx tsx scripts/apply-skill.ts .agents/skills/add-gmail',
    );
    expect(
      commands.filter(
        (command: string) =>
          command === 'npx tsx setup/index.ts --step container -- --runtime docker',
      ),
    ).toHaveLength(2);
  });

  it('switches Gmail from tool-only to channel mode', async () => {
    const projectRoot = createTempProject();
    const fakeHome = path.join(projectRoot, 'home');
    writeProjectFile(projectRoot, '.env.example', 'ASSISTANT_NAME=Andy\n');
    seedGmailToolOnlyTargets(projectRoot);
    writeProjectFile(projectRoot, 'groups/main/AGENTS.md', '## Formatting\n');
    markGmailToolOnlyConfigured(projectRoot);
    writeProjectFile(projectRoot, 'data/sessions/main/agent-runner-src/index.ts', '// stale');
    const oauthSource = path.join(projectRoot, 'gmail-oauth.json');
    fs.writeFileSync(oauthSource, '{"installed":{"client_id":"abc"}}');
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    const prompter = createPrompter({
      input: ['Andy', '@Andy', 'WhatsApp main', oauthSource],
      multiselect: [['WhatsApp']],
      select: [
        'QR code in browser',
        'Self-chat',
        'Switch to Email channel',
        'File path',
      ],
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
      'npx tsx scripts/apply-skill.ts .agents/skills/add-whatsapp': async () => {
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
      'npx tsx scripts/apply-skill.ts .agents/skills/add-gmail': async () => {
        writeProjectFile(projectRoot, 'src/channels/gmail.ts', 'export {};\n');
        return { code: 0, stdout: '{"success":true}', stderr: '' };
      },
      'npx -y @gongrzhe/server-gmail-autoauth-mcp auth': async () => ({
        code: 0,
        stdout: 'gmail auth ok',
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

    expect(fs.existsSync(path.join(projectRoot, 'src/channels/gmail.ts'))).toBe(
      true,
    );
    expect(
      fs.readFileSync(path.join(projectRoot, '.nanoclaw/state.yaml'), 'utf-8'),
    ).toContain('mode: channel');

    const commands = (deps.runCommand as any).mock.calls.map(
      ([command, args]: [string, string[]]) => `${command} ${args.join(' ')}`,
    );
    expect(commands).not.toContain(
      'npx tsx scripts/apply-skill.ts .agents/skills/add-gmail',
    );
    expect(
      commands.filter(
        (command: string) =>
          command === 'npx tsx setup/index.ts --step container -- --runtime docker',
      ),
    ).toHaveLength(2);
  });

  it('switches Gmail from channel mode to tool-only mode', async () => {
    const projectRoot = createTempProject();
    const fakeHome = path.join(projectRoot, 'home');
    writeProjectFile(projectRoot, '.env.example', 'ASSISTANT_NAME=Andy\n');
    seedGmailChannelTargets(projectRoot);
    writeProjectFile(projectRoot, 'data/sessions/main/agent-runner-src/index.ts', '// stale');
    const oauthSource = path.join(projectRoot, 'gmail-oauth.json');
    fs.writeFileSync(oauthSource, '{"installed":{"client_id":"abc"}}');
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    const prompter = createPrompter({
      input: ['Andy', '@Andy', 'WhatsApp main', oauthSource],
      multiselect: [['WhatsApp']],
      select: [
        'QR code in browser',
        'Self-chat',
        'Switch to Tool-only',
        'File path',
      ],
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
      'npx tsx scripts/apply-skill.ts .agents/skills/add-whatsapp': async () => {
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
      'npx -y @gongrzhe/server-gmail-autoauth-mcp auth': async () => ({
        code: 0,
        stdout: 'gmail auth ok',
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

    expect(fs.existsSync(path.join(projectRoot, 'src/channels/gmail.ts'))).toBe(
      false,
    );
    expect(
      fs.readFileSync(path.join(projectRoot, '.nanoclaw/state.yaml'), 'utf-8'),
    ).toContain('mode: tool-only');

    const commands = (deps.runCommand as any).mock.calls.map(
      ([command, args]: [string, string[]]) => `${command} ${args.join(' ')}`,
    );
    expect(commands).not.toContain(
      'npx tsx scripts/apply-skill.ts .agents/skills/add-gmail',
    );
    expect(
      commands.filter(
        (command: string) =>
          command === 'npx tsx setup/index.ts --step container -- --runtime docker',
      ),
    ).toHaveLength(2);
  });

  it('reauthorizes existing Gmail channel mode without refreshing container code', async () => {
    const projectRoot = createTempProject();
    const fakeHome = path.join(projectRoot, 'home');
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    writeProjectFile(projectRoot, '.env.example', 'ASSISTANT_NAME=Andy\n');
    seedGmailChannelTargets(projectRoot);
    writeProjectFile(
      fakeHome,
      '.gmail-mcp/gcp-oauth.keys.json',
      '{"installed":{"client_id":"abc"}}',
    );
    writeProjectFile(
      fakeHome,
      '.gmail-mcp/credentials.json',
      '{"refresh_token":"tok"}',
    );

    const prompter = createPrompter({
      input: ['Andy', '@Andy', 'WhatsApp main'],
      multiselect: [['WhatsApp']],
      select: ['QR code in browser', 'Self-chat', 'Reauthorize Gmail only'],
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
      'npx tsx scripts/apply-skill.ts .agents/skills/add-whatsapp': async () => {
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
      'npx -y @gongrzhe/server-gmail-autoauth-mcp auth': async () => ({
        code: 0,
        stdout: 'gmail auth ok',
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

    expect(fs.existsSync(path.join(projectRoot, 'src/channels/gmail.ts'))).toBe(
      true,
    );

    const commands = (deps.runCommand as any).mock.calls.map(
      ([command, args]: [string, string[]]) => `${command} ${args.join(' ')}`,
    );
    expect(commands).not.toContain(
      'npx tsx scripts/apply-skill.ts .agents/skills/add-gmail',
    );
    expect(commands).toContain('npx -y @gongrzhe/server-gmail-autoauth-mcp auth');
    expect(
      commands.filter(
        (command: string) =>
          command === 'npx tsx setup/index.ts --step container -- --runtime docker',
      ),
    ).toHaveLength(1);
  });

  it('offers Apple Container conversion on macOS', async () => {
    const projectRoot = createTempProject();
    writeProjectFile(projectRoot, '.env.example', 'ASSISTANT_NAME=Andy\n');
    writeProjectFile(
      projectRoot,
      'src/container-runtime.ts',
      "export const CONTAINER_RUNTIME_BIN = 'docker';\n",
    );

    const prompter = createPrompter({
      input: ['Andy', '@Andy', '123456:telegram_token_value_1234567890', '123456', 'Control chat'],
      multiselect: [['Telegram']],
      select: ['Apple Container', 'No'],
      confirm: [false],
    });

    const deps = createDeps(projectRoot, prompter, {
      'npx tsx setup/index.ts --step environment --': async () => ({
        code: 0,
        stdout: `=== NANOCLAW SETUP: CHECK_ENVIRONMENT ===
PLATFORM: macos
IS_WSL: false
IS_HEADLESS: false
APPLE_CONTAINER: installed
DOCKER: running
STATUS: success
=== END ===
`,
        stderr: '',
      }),
      'npx tsx scripts/apply-skill.ts .agents/skills/convert-to-apple-container': async () => {
        writeProjectFile(
          projectRoot,
          'src/container-runtime.ts',
          "export const CONTAINER_RUNTIME_BIN = 'container';\n",
        );
        return { code: 0, stdout: '{"success":true}', stderr: '' };
      },
      'container system status': async () => ({
        code: 0,
        stdout: 'running',
        stderr: '',
      }),
      'npx tsx setup/index.ts --step container -- --runtime apple-container': async () => ({
        code: 0,
        stdout: `=== NANOCLAW SETUP: SETUP_CONTAINER ===
STATUS: success
=== END ===
`,
        stderr: '',
      }),
      'npx tsx scripts/apply-skill.ts .agents/skills/add-telegram': async () => {
        writeProjectFile(projectRoot, 'src/channels/telegram.ts', '');
        return { code: 0, stdout: '{"success":true}', stderr: '' };
      },
      'npx tsx setup/index.ts --step register -- --jid tg:123456 --name Control chat --trigger @Andy --folder telegram_main --channel telegram --assistant-name Andy --is-main --no-trigger-required': async () => ({
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
      'npx tsx scripts/apply-skill.ts .agents/skills/convert-to-apple-container',
    );
    expect(commands).toContain(
      'npx tsx setup/index.ts --step container -- --runtime apple-container',
    );
  });

  it('starts Docker when the environment reports installed_not_running', async () => {
    const projectRoot = createTempProject();
    writeProjectFile(projectRoot, '.env.example', 'ASSISTANT_NAME=Andy\n');

    const prompter = createPrompter({
      input: ['Nova', '@Nova', '123456:telegram_token_value_1234567890', '123456', 'Control chat'],
      multiselect: [['Telegram']],
      select: ['No'],
      confirm: [false],
    });

    let environmentRuns = 0;
    const deps = createDeps(projectRoot, prompter, {
      'npx tsx setup/index.ts --step environment --': async () => {
        environmentRuns += 1;
        return {
          code: 0,
          stdout: `=== NANOCLAW SETUP: CHECK_ENVIRONMENT ===
PLATFORM: linux
IS_WSL: false
IS_HEADLESS: false
APPLE_CONTAINER: not_found
DOCKER: ${environmentRuns === 1 ? 'installed_not_running' : 'running'}
STATUS: success
=== END ===
`,
          stderr: '',
        };
      },
      'sudo systemctl start docker': async () => ({
        code: 0,
        stdout: '',
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
      'npx tsx scripts/apply-skill.ts .agents/skills/add-telegram': async () => {
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

    const commands = (deps.runCommand as any).mock.calls.map(
      ([command, args]: [string, string[]]) => `${command} ${args.join(' ')}`,
    );
    expect(commands).toContain('sudo systemctl start docker');
    expect(environmentRuns).toBe(2);
  });

  it('retries the container build after clearing stale per-group agent runner copies', async () => {
    const projectRoot = createTempProject();
    writeProjectFile(projectRoot, '.env.example', 'ASSISTANT_NAME=Andy\n');
    writeProjectFile(projectRoot, 'data/sessions/main/agent-runner-src/index.ts', '// stale');

    const prompter = createPrompter({
      input: ['Andy', '@Andy', '123456:telegram_token_value_1234567890', '123456', 'Control chat'],
      multiselect: [['Telegram']],
      select: ['No'],
      confirm: [false],
    });

    let containerRuns = 0;
    const deps = createDeps(projectRoot, prompter, {
      'npx tsx setup/index.ts --step environment --': async () => ({
        code: 0,
        stdout: `=== NANOCLAW SETUP: CHECK_ENVIRONMENT ===
PLATFORM: linux
IS_WSL: false
IS_HEADLESS: false
NODE: installed
NPM: installed
BUILD_TOOLS: ready
HOMEBREW: not_found
APT_GET: installed
DNF: not_found
YUM: not_found
APPLE_CONTAINER: not_found
DOCKER: running
STATUS: success
=== END ===
`,
        stderr: '',
      }),
      'npx tsx setup/index.ts --step container -- --runtime docker': async () => {
        containerRuns += 1;
        if (containerRuns === 1) {
          return {
            code: 1,
            stdout: `=== NANOCLAW SETUP: SETUP_CONTAINER ===
STATUS: failed
ERROR: stale copy detected
=== END ===
`,
            stderr: '',
          };
        }
        return {
          code: 0,
          stdout: `=== NANOCLAW SETUP: SETUP_CONTAINER ===
STATUS: success
=== END ===
`,
          stderr: '',
        };
      },
      'npx tsx scripts/apply-skill.ts .agents/skills/add-telegram': async () => {
        writeProjectFile(projectRoot, 'src/channels/telegram.ts', '');
        return { code: 0, stdout: '{"success":true}', stderr: '' };
      },
      'npx tsx setup/index.ts --step register -- --jid tg:123456 --name Control chat --trigger @Andy --folder telegram_main --channel telegram --assistant-name Andy --is-main --no-trigger-required': async () => ({
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

    expect(containerRuns).toBe(2);
    expect(
      fs.existsSync(path.join(projectRoot, 'data/sessions/main/agent-runner-src')),
    ).toBe(false);
    expect((prompter.note as any).mock.calls.some(([message]: [string]) =>
      message.includes('container build failed'),
    )).toBe(true);
  });

  it('installs Docker when it is missing on Linux', async () => {
    const projectRoot = createTempProject();
    writeProjectFile(projectRoot, '.env.example', 'ASSISTANT_NAME=Andy\n');

    const prompter = createPrompter({
      input: ['Andy', '@Andy', '123456:telegram_token_value_1234567890', '123456', 'Control chat'],
      multiselect: [['Telegram']],
      select: ['No'],
      confirm: [false],
    });

    let environmentRuns = 0;
    const deps = createDeps(projectRoot, prompter, {
      'npx tsx setup/index.ts --step environment --': async () => {
        environmentRuns += 1;
        return {
          code: 0,
          stdout: `=== NANOCLAW SETUP: CHECK_ENVIRONMENT ===
PLATFORM: linux
IS_WSL: false
IS_HEADLESS: false
APPLE_CONTAINER: not_found
DOCKER: ${environmentRuns === 1 ? 'not_found' : 'running'}
STATUS: success
=== END ===
`,
          stderr: '',
        };
      },
      'sudo sh -lc curl -fsSL https://get.docker.com | sh': async () => ({
        code: 0,
        stdout: 'installed',
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
      'npx tsx scripts/apply-skill.ts .agents/skills/add-telegram': async () => {
        writeProjectFile(projectRoot, 'src/channels/telegram.ts', '');
        return { code: 0, stdout: '{"success":true}', stderr: '' };
      },
      'npx tsx setup/index.ts --step register -- --jid tg:123456 --name Control chat --trigger @Andy --folder telegram_main --channel telegram --assistant-name Andy --is-main --no-trigger-required': async () => ({
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
    expect(commands).toContain('sudo sh -lc curl -fsSL https://get.docker.com | sh');
    expect(environmentRuns).toBe(2);
  });

  it('installs missing linux build tools and node before continuing setup', async () => {
    const projectRoot = createTempProject();
    writeProjectFile(projectRoot, '.env.example', 'ASSISTANT_NAME=Andy\n');

    const prompter = createPrompter({
      input: ['Andy', '@Andy', '123456:telegram_token_value_1234567890', '123456', 'Control chat'],
      multiselect: [['Telegram']],
      select: ['No'],
      confirm: [false],
    });

    let environmentRuns = 0;
    const deps = createDeps(projectRoot, prompter, {
      'npx tsx setup/index.ts --step environment --': async () => {
        environmentRuns += 1;
        if (environmentRuns === 1) {
          return {
            code: 0,
            stdout: `=== NANOCLAW SETUP: CHECK_ENVIRONMENT ===
PLATFORM: linux
IS_WSL: false
IS_HEADLESS: false
NODE: not_found
NPM: not_found
BUILD_TOOLS: not_found
HOMEBREW: not_found
APT_GET: installed
DNF: not_found
YUM: not_found
APPLE_CONTAINER: not_found
DOCKER: running
STATUS: success
=== END ===
`,
            stderr: '',
          };
        }
        if (environmentRuns === 2) {
          return {
            code: 0,
            stdout: `=== NANOCLAW SETUP: CHECK_ENVIRONMENT ===
PLATFORM: linux
IS_WSL: false
IS_HEADLESS: false
NODE: not_found
NPM: not_found
BUILD_TOOLS: ready
HOMEBREW: not_found
APT_GET: installed
DNF: not_found
YUM: not_found
APPLE_CONTAINER: not_found
DOCKER: running
STATUS: success
=== END ===
`,
            stderr: '',
          };
        }
        return {
          code: 0,
          stdout: `=== NANOCLAW SETUP: CHECK_ENVIRONMENT ===
PLATFORM: linux
IS_WSL: false
IS_HEADLESS: false
NODE: installed
NPM: installed
BUILD_TOOLS: ready
HOMEBREW: not_found
APT_GET: installed
DNF: not_found
YUM: not_found
APPLE_CONTAINER: not_found
DOCKER: running
STATUS: success
=== END ===
`,
          stderr: '',
        };
      },
      'sudo apt-get install -y build-essential python3': async () => ({
        code: 0,
        stdout: 'installed build tools',
        stderr: '',
      }),
      'sudo apt-get install -y nodejs npm': async () => ({
        code: 0,
        stdout: 'installed node',
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
      'npx tsx scripts/apply-skill.ts .agents/skills/add-telegram': async () => {
        writeProjectFile(projectRoot, 'src/channels/telegram.ts', '');
        return { code: 0, stdout: '{"success":true}', stderr: '' };
      },
      'npx tsx setup/index.ts --step register -- --jid tg:123456 --name Control chat --trigger @Andy --folder telegram_main --channel telegram --assistant-name Andy --is-main --no-trigger-required': async () => ({
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
    expect(commands).toContain('sudo apt-get install -y build-essential python3');
    expect(commands).toContain('sudo apt-get install -y nodejs npm');
    expect(environmentRuns).toBe(3);
  });

  it('installs Apple Container when selected and missing on macOS', async () => {
    const projectRoot = createTempProject();
    writeProjectFile(projectRoot, '.env.example', 'ASSISTANT_NAME=Andy\n');

    const prompter = createPrompter({
      input: ['Andy', '@Andy', '123456:telegram_token_value_1234567890', '123456', 'Control chat'],
      multiselect: [['Telegram']],
      select: ['Apple Container', 'No'],
      confirm: [false],
    });

    let environmentRuns = 0;
    const deps = createDeps(projectRoot, prompter, {
      'npx tsx setup/index.ts --step environment --': async () => {
        environmentRuns += 1;
        return {
          code: 0,
          stdout: `=== NANOCLAW SETUP: CHECK_ENVIRONMENT ===
PLATFORM: macos
IS_WSL: false
IS_HEADLESS: false
NODE: installed
NPM: installed
BUILD_TOOLS: ready
HOMEBREW: installed
APT_GET: not_found
DNF: not_found
YUM: not_found
APPLE_CONTAINER: ${environmentRuns === 1 ? 'not_found' : 'installed'}
DOCKER: not_found
STATUS: success
=== END ===
`,
          stderr: '',
        };
      },
      'brew install --cask container': async () => ({
        code: 0,
        stdout: 'installed',
        stderr: '',
      }),
      'container system status': async () => ({
        code: 0,
        stdout: 'running',
        stderr: '',
      }),
      'npx tsx scripts/apply-skill.ts .agents/skills/convert-to-apple-container': async () => {
        writeProjectFile(
          projectRoot,
          'src/container-runtime.ts',
          "export const CONTAINER_RUNTIME_BIN = 'container';\n",
        );
        return { code: 0, stdout: '{"success":true}', stderr: '' };
      },
      'npx tsx setup/index.ts --step container -- --runtime apple-container': async () => ({
        code: 0,
        stdout: `=== NANOCLAW SETUP: SETUP_CONTAINER ===
STATUS: success
=== END ===
`,
        stderr: '',
      }),
      'npx tsx scripts/apply-skill.ts .agents/skills/add-telegram': async () => {
        writeProjectFile(projectRoot, 'src/channels/telegram.ts', '');
        return { code: 0, stdout: '{"success":true}', stderr: '' };
      },
      'npx tsx setup/index.ts --step register -- --jid tg:123456 --name Control chat --trigger @Andy --folder telegram_main --channel telegram --assistant-name Andy --is-main --no-trigger-required': async () => ({
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
    expect(commands).toContain('brew install --cask container');
    expect(environmentRuns).toBe(2);
  });

  it('retries verification after rerunning service setup', async () => {
    const projectRoot = createTempProject();
    writeProjectFile(projectRoot, '.env.example', 'ASSISTANT_NAME=Andy\n');

    const prompter = createPrompter({
      input: ['Andy', '@Andy', '123456:telegram_token_value_1234567890', '123456', 'Control chat'],
      multiselect: [['Telegram']],
      select: ['No'],
      confirm: [false],
    });

    let serviceRuns = 0;
    let verifyRuns = 0;
    const deps = createDeps(projectRoot, prompter, {
      'npx tsx setup/index.ts --step environment --': async () => ({
        code: 0,
        stdout: `=== NANOCLAW SETUP: CHECK_ENVIRONMENT ===
PLATFORM: linux
IS_WSL: false
IS_HEADLESS: false
NODE: installed
NPM: installed
BUILD_TOOLS: ready
HOMEBREW: not_found
APT_GET: installed
DNF: not_found
YUM: not_found
APPLE_CONTAINER: not_found
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
      'npx tsx scripts/apply-skill.ts .agents/skills/add-telegram': async () => {
        writeProjectFile(projectRoot, 'src/channels/telegram.ts', '');
        return { code: 0, stdout: '{"success":true}', stderr: '' };
      },
      'npx tsx setup/index.ts --step register -- --jid tg:123456 --name Control chat --trigger @Andy --folder telegram_main --channel telegram --assistant-name Andy --is-main --no-trigger-required': async () => ({
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
      'npx tsx setup/index.ts --step service --': async () => {
        serviceRuns += 1;
        return {
          code: 0,
          stdout: `=== NANOCLAW SETUP: SETUP_SERVICE ===
STATUS: success
=== END ===
`,
          stderr: '',
        };
      },
      'npx tsx setup/index.ts --step verify --': async () => {
        verifyRuns += 1;
        if (verifyRuns === 1) {
          return {
            code: 1,
            stdout: `=== NANOCLAW SETUP: VERIFY ===
STATUS: failed
ERROR: service not responding
=== END ===
`,
            stderr: '',
          };
        }
        return {
          code: 0,
          stdout: `=== NANOCLAW SETUP: VERIFY ===
STATUS: success
=== END ===
`,
          stderr: '',
        };
      },
    });

    await runGuidedSetup(deps);

    expect(serviceRuns).toBe(2);
    expect(verifyRuns).toBe(2);
    expect((prompter.note as any).mock.calls.some(([message]: [string]) =>
      message.includes('verification failed'),
    )).toBe(true);
  });

  it('installs Homebrew and Node on macOS before runtime selection', async () => {
    const projectRoot = createTempProject();
    writeProjectFile(projectRoot, '.env.example', 'ASSISTANT_NAME=Andy\n');

    const prompter = createPrompter({
      input: ['Andy', '@Andy', '123456:telegram_token_value_1234567890', '123456', 'Control chat'],
      multiselect: [['Telegram']],
      select: ['Docker', 'No'],
      confirm: [false],
    });

    let environmentRuns = 0;
    const deps = createDeps(projectRoot, prompter, {
      'npx tsx setup/index.ts --step environment --': async () => {
        environmentRuns += 1;
        if (environmentRuns === 1) {
          return {
            code: 0,
            stdout: `=== NANOCLAW SETUP: CHECK_ENVIRONMENT ===
PLATFORM: macos
IS_WSL: false
IS_HEADLESS: false
NODE: not_found
NPM: not_found
BUILD_TOOLS: ready
HOMEBREW: not_found
APT_GET: not_found
DNF: not_found
YUM: not_found
APPLE_CONTAINER: not_found
DOCKER: running
STATUS: success
=== END ===
`,
            stderr: '',
          };
        }
        if (environmentRuns === 2) {
          return {
            code: 0,
            stdout: `=== NANOCLAW SETUP: CHECK_ENVIRONMENT ===
PLATFORM: macos
IS_WSL: false
IS_HEADLESS: false
NODE: not_found
NPM: not_found
BUILD_TOOLS: ready
HOMEBREW: installed
APT_GET: not_found
DNF: not_found
YUM: not_found
APPLE_CONTAINER: not_found
DOCKER: running
STATUS: success
=== END ===
`,
            stderr: '',
          };
        }
        return {
          code: 0,
          stdout: `=== NANOCLAW SETUP: CHECK_ENVIRONMENT ===
PLATFORM: macos
IS_WSL: false
IS_HEADLESS: false
NODE: installed
NPM: installed
BUILD_TOOLS: ready
HOMEBREW: installed
APT_GET: not_found
DNF: not_found
YUM: not_found
APPLE_CONTAINER: not_found
DOCKER: running
STATUS: success
=== END ===
`,
          stderr: '',
        };
      },
      'sh -lc NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"': async () => ({
        code: 0,
        stdout: 'installed brew',
        stderr: '',
      }),
      'brew install node': async () => ({
        code: 0,
        stdout: 'installed node',
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
      'npx tsx scripts/apply-skill.ts .agents/skills/add-telegram': async () => {
        writeProjectFile(projectRoot, 'src/channels/telegram.ts', '');
        return { code: 0, stdout: '{"success":true}', stderr: '' };
      },
      'npx tsx setup/index.ts --step register -- --jid tg:123456 --name Control chat --trigger @Andy --folder telegram_main --channel telegram --assistant-name Andy --is-main --no-trigger-required': async () => ({
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
      'sh -lc NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
    );
    expect(commands).toContain('brew install node');
    expect(environmentRuns).toBe(3);
  });

  it('starts Apple Container before building when selected', async () => {
    const projectRoot = createTempProject();
    writeProjectFile(projectRoot, '.env.example', 'ASSISTANT_NAME=Andy\n');
    writeProjectFile(
      projectRoot,
      'src/container-runtime.ts',
      "export const CONTAINER_RUNTIME_BIN = 'container';\n",
    );

    const prompter = createPrompter({
      input: ['Andy', '@Andy', '123456:telegram_token_value_1234567890', '123456', 'Control chat'],
      multiselect: [['Telegram']],
      select: ['Apple Container', 'No'],
      confirm: [false],
    });

    const deps = createDeps(projectRoot, prompter, {
      'npx tsx setup/index.ts --step environment --': async () => ({
        code: 0,
        stdout: `=== NANOCLAW SETUP: CHECK_ENVIRONMENT ===
PLATFORM: macos
IS_WSL: false
IS_HEADLESS: false
APPLE_CONTAINER: installed
DOCKER: running
STATUS: success
=== END ===
`,
        stderr: '',
      }),
      'container system status': async () => ({
        code: 1,
        stdout: '',
        stderr: 'not running',
      }),
      'container system start': async () => ({
        code: 0,
        stdout: 'started',
        stderr: '',
      }),
      'npx tsx setup/index.ts --step container -- --runtime apple-container': async () => ({
        code: 0,
        stdout: `=== NANOCLAW SETUP: SETUP_CONTAINER ===
STATUS: success
=== END ===
`,
        stderr: '',
      }),
      'npx tsx scripts/apply-skill.ts .agents/skills/add-telegram': async () => {
        writeProjectFile(projectRoot, 'src/channels/telegram.ts', '');
        return { code: 0, stdout: '{"success":true}', stderr: '' };
      },
      'npx tsx setup/index.ts --step register -- --jid tg:123456 --name Control chat --trigger @Andy --folder telegram_main --channel telegram --assistant-name Andy --is-main --no-trigger-required': async () => ({
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
    expect(commands).toContain('container system status');
    expect(commands).toContain('container system start');
  });
});
