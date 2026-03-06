import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { fileURLToPath } from 'url';
import { parse, stringify } from 'yaml';

import { NANOCLAW_DIR, SKILLS_SCHEMA_VERSION, STATE_FILE } from '../skills-engine/constants.js';

type ChannelName = 'whatsapp' | 'telegram' | 'slack' | 'discord' | 'gmail';
type GmailMode = 'disabled' | 'tool-only' | 'channel';

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type RunOptions = {
  echoStdout?: boolean;
  echoStderr?: boolean;
};

type SetupStatus = {
  step: string;
  fields: Record<string, string>;
};

export interface Prompter {
  select(
    message: string,
    options: string[],
    defaultIndex?: number,
  ): Promise<string>;
  multiselect(
    message: string,
    options: string[],
    defaultIndexes?: number[],
  ): Promise<string[]>;
  input(message: string, defaultValue?: string): Promise<string>;
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
  note(message: string): void;
}

export interface GuidedDeps {
  projectRoot: string;
  prompter: Prompter;
  runCommand(
    command: string,
    args: string[],
    options?: RunOptions,
  ): Promise<RunResult>;
}

type ChannelSetup = {
  channel: ChannelName;
  isMain: boolean;
  assistantName: string;
  trigger: string;
};

type RuntimeChoice = 'docker' | 'apple-container';

type SkillState = {
  skills_system_version: string;
  core_version: string;
  applied_skills: Array<{
    name: string;
    version: string;
    applied_at: string;
    file_hashes: Record<string, string>;
    structured_outcomes?: Record<string, unknown>;
  }>;
};

type RecoverableStageOptions = {
  retryLabel?: string;
  remediate?: () => Promise<void>;
};

const CHANNELS: ChannelName[] = ['whatsapp', 'telegram', 'slack', 'discord'];

const CHANNEL_LABELS: Record<ChannelName, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  slack: 'Slack',
  discord: 'Discord',
  gmail: 'Gmail',
};

const TOKEN_ENV_KEYS: Record<Exclude<ChannelName, 'whatsapp'>, string[]> = {
  telegram: ['TELEGRAM_BOT_TOKEN'],
  slack: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
  discord: ['DISCORD_BOT_TOKEN'],
  gmail: [],
};

const MANUAL_CHANNEL_HELP: Record<Exclude<ChannelName, 'whatsapp'>, string> = {
  telegram:
    'Open Telegram, create a bot with @BotFather if needed, then paste the bot token. For the main chat, send /chatid and paste the chat ID here.',
  slack:
    'Create a Slack app with Socket Mode, then paste the Bot Token and App Token. For registration, paste the target channel ID.',
  discord:
    'Create or open a Discord bot app, invite it to your server, then paste the bot token. Enable Developer Mode to copy the target channel ID.',
  gmail:
    'Gmail is configured as an optional integration, not as a primary chat. The guided flow will ask for Google OAuth credentials and start the browser authorization flow.',
};

const CHANNEL_CREATION_GUIDES: Record<
  Exclude<ChannelName, 'whatsapp' | 'gmail'>,
  string[]
> = {
  telegram: [
    'Create a Telegram bot with @BotFather: /newbot, choose a bot name, then choose a username ending in "bot".',
    'Copy the bot token that BotFather returns.',
    'If you plan to use groups, turn off Group Privacy in BotFather so the bot can see normal group messages.',
  ],
  slack: [
    'Create a Slack app at api.slack.com/apps.',
    'Enable Socket Mode and generate an App Token (xapp-...).',
    'Add bot scopes: chat:write, channels:history, groups:history, im:history, channels:read, groups:read, users:read.',
    'Subscribe to message.channels, message.groups, and message.im events, then install the app and copy the Bot Token (xoxb-...).',
  ],
  discord: [
    'Create an application in the Discord Developer Portal and add a bot user.',
    'Reset the bot token and copy it immediately.',
    'Enable Message Content Intent under the Bot settings.',
    'Use OAuth2 > URL Generator with the bot scope and invite the bot to your server.',
  ],
};

const CHANNEL_REGISTRATION_GUIDES: Record<
  Exclude<ChannelName, 'whatsapp' | 'gmail'>,
  string[]
> = {
  telegram: [
    'Open the bot chat or target group in Telegram.',
    'Send /chatid and copy the returned chat ID.',
    'Use the raw numeric value here; NanoClaw will normalize it to tg:<id>.',
  ],
  slack: [
    'Add the bot to the target Slack channel first.',
    'Copy the channel link or inspect the Slack URL and extract the C... channel ID.',
    'Use the raw channel ID here; NanoClaw will normalize it to slack:<id>.',
  ],
  discord: [
    'Enable Developer Mode in Discord.',
    'Right-click the target text channel and choose Copy Channel ID.',
    'Use the raw channel ID here; NanoClaw will normalize it to dc:<id>.',
  ],
};

const TOKEN_VALIDATORS: Partial<
  Record<
    Exclude<ChannelName, 'whatsapp' | 'gmail'>,
    Record<string, { pattern: RegExp; help: string }>
  >
> = {
  telegram: {
    TELEGRAM_BOT_TOKEN: {
      pattern: /^\d{5,}:[A-Za-z0-9_-]{20,}$/,
      help: 'Expected format: <digits>:<bot token from @BotFather>.',
    },
  },
  slack: {
    SLACK_BOT_TOKEN: {
      pattern: /^xoxb-[A-Za-z0-9-]+$/,
      help: 'Expected a Slack bot token starting with xoxb-.',
    },
    SLACK_APP_TOKEN: {
      pattern: /^xapp-[A-Za-z0-9-]+$/,
      help: 'Expected a Slack app token starting with xapp-.',
    },
  },
  discord: {
    DISCORD_BOT_TOKEN: {
      pattern: /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
      help: 'Expected a Discord bot token with three dot-separated segments.',
    },
  },
};

const CHANNEL_ID_VALIDATORS: Record<
  Exclude<ChannelName, 'whatsapp' | 'gmail'>,
  { pattern: RegExp; help: string }
> = {
  telegram: {
    pattern: /^-?\d+$/,
    help: 'Telegram chat IDs are numeric, for example 123456 or -1001234567890.',
  },
  slack: {
    pattern: /^[A-Z0-9]{8,}$/,
    help: 'Slack channel IDs are uppercase IDs such as C0123456789.',
  },
  discord: {
    pattern: /^\d{5,}$/,
    help: 'Discord channel IDs are long numeric snowflakes.',
  },
};

const GMAIL_EMAIL_INSTRUCTIONS = `## Email Notifications

When you receive an email notification (messages starting with \`[Email from ...\`), inform the user about it but do NOT reply to the email unless specifically asked. You have Gmail tools available - use them only when the user explicitly asks you to reply, forward, or take action on an email.
`;

function getGmailConfigDir(): string {
  return path.join(os.homedir(), '.gmail-mcp');
}

function getSkillsStatePath(projectRoot: string): string {
  return path.join(projectRoot, NANOCLAW_DIR, STATE_FILE);
}

function getProjectVersion(projectRoot: string): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'),
    ) as { version?: string };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function ensureSkillsState(projectRoot: string): SkillState {
  const statePath = getSkillsStatePath(projectRoot);
  if (fs.existsSync(statePath)) {
    return parse(fs.readFileSync(statePath, 'utf-8')) as SkillState;
  }

  const state: SkillState = {
    skills_system_version: SKILLS_SCHEMA_VERSION,
    core_version: getProjectVersion(projectRoot),
    applied_skills: [],
  };
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, stringify(state));
  return state;
}

function writeSkillsState(projectRoot: string, state: SkillState): void {
  const statePath = getSkillsStatePath(projectRoot);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.tmp`;
  fs.writeFileSync(tmpPath, stringify(state));
  fs.renameSync(tmpPath, statePath);
}

function upsertAppliedSkill(
  projectRoot: string,
  skillName: string,
  filePaths: string[],
  structuredOutcomes?: Record<string, unknown>,
): void {
  const state = ensureSkillsState(projectRoot);
  state.applied_skills = state.applied_skills.filter(
    (skill) => skill.name !== skillName,
  );

  const fileHashes: Record<string, string> = {};
  for (const relativePath of filePaths) {
    const absolutePath = path.join(projectRoot, relativePath);
    if (!fs.existsSync(absolutePath)) continue;
    fileHashes[relativePath] = computeFileHash(absolutePath);
  }

  state.applied_skills.push({
    name: skillName,
    version: '1.0.0',
    applied_at: new Date().toISOString(),
    file_hashes: fileHashes,
    structured_outcomes: structuredOutcomes,
  });
  writeSkillsState(projectRoot, state);
}

function ensureSnippet(content: string, anchor: string, snippet: string): string {
  if (content.includes(snippet.trim())) return content;
  const index = content.indexOf(anchor);
  if (index === -1) {
    throw new Error(`Could not find anchor: ${anchor}`);
  }
  return `${content.slice(0, index)}${snippet}${content.slice(index)}`;
}

function ensureGmailAgentRunnerTools(projectRoot: string): void {
  const agentRunnerPath = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
    'index.ts',
  );
  if (!fs.existsSync(agentRunnerPath)) {
    throw new Error('Missing container/agent-runner/src/index.ts');
  }

  let content = fs.readFileSync(agentRunnerPath, 'utf-8');

  if (!content.includes("'mcp__gmail__*'")) {
    const target = "'mcp__nanoclaw__*'";
    if (!content.includes(target)) {
      throw new Error('Missing allowedTools nanoclaw anchor for Gmail tool patch');
    }
    content = content.replace(
      target,
      `${target},\n        'mcp__gmail__*'`,
    );
  }

  if (!content.includes('@gongrzhe/server-gmail-autoauth-mcp')) {
    const anchor = "        nanoclaw: {\n";
    const snippet =
      "        gmail: {\n" +
      "          command: 'npx',\n" +
      "          args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],\n" +
      "        },\n";
    content = ensureSnippet(content, anchor, snippet);
  }

  fs.writeFileSync(agentRunnerPath, content);
}

function ensureGmailContainerMount(projectRoot: string): void {
  const runnerPath = path.join(projectRoot, 'src', 'container-runner.ts');
  if (!fs.existsSync(runnerPath)) return;

  let content = fs.readFileSync(runnerPath, 'utf-8');
  if (content.includes('/home/node/.gmail-mcp')) return;

  if (!content.includes("import os from 'os';")) {
    const importAnchor = "import fs from 'fs';\n";
    if (!content.includes(importAnchor)) {
      throw new Error('Missing fs import anchor for Gmail mount patch');
    }
    content = content.replace(importAnchor, `${importAnchor}import os from 'os';\n`);
  }

  if (!content.includes('const homeDir = os.homedir();')) {
    const homeAnchor = '  const projectRoot = process.cwd();\n';
    if (!content.includes(homeAnchor)) {
      throw new Error('Missing project root anchor for Gmail mount patch');
    }
    content = content.replace(
      homeAnchor,
      `${homeAnchor}  const homeDir = os.homedir();\n`,
    );
  }

  const mountAnchor = '  // Per-group IPC namespace: each group gets its own IPC directory\n';
  const mountSnippet =
    "  // Gmail credentials directory (for Gmail MCP inside the container)\n" +
    "  const gmailDir = path.join(homeDir, '.gmail-mcp');\n" +
    "  if (fs.existsSync(gmailDir)) {\n" +
    "    mounts.push({\n" +
    "      hostPath: gmailDir,\n" +
    "      containerPath: '/home/node/.gmail-mcp',\n" +
    "      readonly: false, // MCP may need to refresh OAuth tokens\n" +
    "    });\n" +
    "  }\n\n";
  content = ensureSnippet(content, mountAnchor, mountSnippet);

  fs.writeFileSync(runnerPath, content);
}

function clearStaleAgentRunnerCopies(projectRoot: string): void {
  const sessionsDir = path.join(projectRoot, 'data', 'sessions');
  if (!fs.existsSync(sessionsDir)) return;

  for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    fs.rmSync(path.join(sessionsDir, entry.name, 'agent-runner-src'), {
      recursive: true,
      force: true,
    });
  }
}

function ensureMainGroupEmailGuidance(projectRoot: string): void {
  const guidePath = path.join(projectRoot, 'groups', 'main', 'AGENTS.md');
  let content = '';
  if (fs.existsSync(guidePath)) {
    content = fs.readFileSync(guidePath, 'utf-8');
    if (content.includes('## Email Notifications')) return;
  } else {
    fs.mkdirSync(path.dirname(guidePath), { recursive: true });
  }

  const formattingAnchor = '\n## Formatting';
  if (content.includes(formattingAnchor)) {
    content = content.replace(
      formattingAnchor,
      `\n${GMAIL_EMAIL_INSTRUCTIONS}\n${formattingAnchor.trimStart()}`,
    );
  } else {
    const trimmed = content.trimEnd();
    content = trimmed
      ? `${trimmed}\n\n${GMAIL_EMAIL_INSTRUCTIONS}\n`
      : `${GMAIL_EMAIL_INSTRUCTIONS}\n`;
  }

  fs.writeFileSync(guidePath, content);
}

function applyGmailToolOnlyMode(projectRoot: string): void {
  ensureGmailContainerMount(projectRoot);
  ensureGmailAgentRunnerTools(projectRoot);
  upsertAppliedSkill(
    projectRoot,
    'gmail',
    ['src/container-runner.ts', 'container/agent-runner/src/index.ts'],
    { mode: 'tool-only' },
  );
}

function removeGmailChannelFiles(projectRoot: string): void {
  const channelPath = path.join(projectRoot, 'src', 'channels', 'gmail.ts');
  const channelTestPath = path.join(
    projectRoot,
    'src',
    'channels',
    'gmail.test.ts',
  );
  fs.rmSync(channelPath, { force: true });
  fs.rmSync(channelTestPath, { force: true });

  const channelIndexPath = path.join(projectRoot, 'src', 'channels', 'index.ts');
  if (fs.existsSync(channelIndexPath)) {
    const content = fs.readFileSync(channelIndexPath, 'utf-8');
    const next = content
      .replace(/^\s*import '\.\/gmail\.js';\n?/m, '')
      .replace(/^\/\/ gmail\s*$/m, '// gmail');
    fs.writeFileSync(channelIndexPath, next);
  }
}

function detectConfiguredGmailMode(projectRoot: string): GmailMode {
  if (fs.existsSync(path.join(projectRoot, 'src', 'channels', 'gmail.ts'))) {
    return 'channel';
  }

  const statePath = getSkillsStatePath(projectRoot);
  if (fs.existsSync(statePath)) {
    try {
      const state = parse(fs.readFileSync(statePath, 'utf-8')) as SkillState;
      const gmailEntry = state.applied_skills.find((skill) => skill.name === 'gmail');
      if (gmailEntry?.structured_outcomes?.mode === 'tool-only') {
        return 'tool-only';
      }
    } catch {
      // Fall back to file heuristics below.
    }
  }

  const agentRunnerPath = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
    'index.ts',
  );
  if (
    fs.existsSync(agentRunnerPath) &&
    fs
      .readFileSync(agentRunnerPath, 'utf-8')
      .includes('@gongrzhe/server-gmail-autoauth-mcp')
  ) {
    return 'tool-only';
  }

  return 'disabled';
}

type GmailConfigurationPlan = {
  mode: GmailMode;
  reauthorize: boolean;
  codeChanged: boolean;
};

async function planGmailConfiguration(
  deps: GuidedDeps,
  currentMode: GmailMode,
): Promise<GmailConfigurationPlan> {
  if (currentMode === 'disabled') {
    const gmailModeLabel = await deps.prompter.select(
      'Enable Gmail integration?',
      ['No', 'Tool-only', 'Email channel'],
      0,
    );
    const gmailMode: GmailMode =
      gmailModeLabel === 'Tool-only'
        ? 'tool-only'
        : gmailModeLabel === 'Email channel'
          ? 'channel'
          : 'disabled';
    return {
      mode: gmailMode,
      reauthorize: false,
      codeChanged: gmailMode !== 'disabled',
    };
  }

  const switchLabel =
    currentMode === 'tool-only'
      ? 'Switch to Email channel'
      : 'Switch to Tool-only';
  const choice = await deps.prompter.select(
    `Gmail is already configured in ${currentMode} mode. What do you want to do?`,
    ['Keep current setup', 'Reauthorize Gmail only', switchLabel],
    0,
  );

  if (choice === 'Reauthorize Gmail only') {
    return {
      mode: currentMode,
      reauthorize: true,
      codeChanged: false,
    };
  }

  if (choice === switchLabel) {
    return {
      mode: currentMode === 'tool-only' ? 'channel' : 'tool-only',
      reauthorize: false,
      codeChanged: true,
    };
  }

  return {
    mode: currentMode,
    reauthorize: false,
    codeChanged: false,
  };
}

export function isAppleContainerConverted(projectRoot: string): boolean {
  const runtimePath = path.join(projectRoot, 'src', 'container-runtime.ts');
  if (!fs.existsSync(runtimePath)) return false;
  const content = fs.readFileSync(runtimePath, 'utf-8');
  return content.includes("CONTAINER_RUNTIME_BIN = 'container'");
}

export function parseStatusBlocks(outputText: string): SetupStatus[] {
  const lines = outputText.split(/\r?\n/);
  const blocks: SetupStatus[] = [];
  let currentStep = '';
  let currentFields: Record<string, string> | null = null;

  for (const line of lines) {
    const start = line.match(/^=== NANOCLAW SETUP: (.+) ===$/);
    if (start) {
      currentStep = start[1];
      currentFields = {};
      continue;
    }
    if (line === '=== END ===') {
      if (currentFields) {
        blocks.push({ step: currentStep, fields: currentFields });
      }
      currentStep = '';
      currentFields = null;
      continue;
    }
    if (!currentFields) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    currentFields[key] = value;
  }

  return blocks;
}

export function parseLatestStatus(outputText: string): SetupStatus | null {
  const blocks = parseStatusBlocks(outputText);
  return blocks.length > 0 ? blocks[blocks.length - 1] : null;
}

export function parseGroupList(outputText: string): Array<{
  jid: string;
  name: string;
}> {
  return outputText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const sep = line.indexOf('|');
      if (sep === -1) return null;
      return {
        jid: line.slice(0, sep),
        name: line.slice(sep + 1),
      };
    })
    .filter((value): value is { jid: string; name: string } => Boolean(value));
}

export function sanitizeFolderSlug(inputText: string): string {
  return inputText
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'chat';
}

export function normalizeChannelJid(
  channel: ChannelName,
  rawValue: string,
): string {
  const value = rawValue.trim();
  if (channel === 'whatsapp') return value;
  if (channel === 'telegram') {
    return value.startsWith('tg:') ? value : `tg:${value}`;
  }
  if (channel === 'slack') {
    return value.startsWith('slack:') ? value : `slack:${value}`;
  }
  return value.startsWith('dc:') ? value : `dc:${value}`;
}

export function upsertEnvContent(
  currentContent: string,
  updates: Record<string, string>,
): string {
  const lines = currentContent.length > 0 ? currentContent.split(/\r?\n/) : [];
  const nextLines = [...lines];
  const remaining = new Map(Object.entries(updates));

  for (let index = 0; index < nextLines.length; index += 1) {
    const line = nextLines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sep = line.indexOf('=');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    if (!remaining.has(key)) continue;
    nextLines[index] = `${key}=${formatEnvValue(remaining.get(key) ?? '')}`;
    remaining.delete(key);
  }

  for (const [key, value] of remaining) {
    nextLines.push(`${key}=${formatEnvValue(value)}`);
  }

  return `${nextLines.join('\n').replace(/\n+$/u, '')}\n`;
}

export function readProjectEnvValues(
  projectRoot: string,
  keys: string[],
): Record<string, string> {
  const envPath = path.join(projectRoot, '.env');
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    return {};
  }

  const wanted = new Set(keys);
  const values: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sep = trimmed.indexOf('=');
    if (sep === -1) continue;
    const key = trimmed.slice(0, sep).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(sep + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) values[key] = value;
  }

  return values;
}

export async function promptRequiredInput(
  prompter: Prompter,
  message: string,
  defaultValue = '',
): Promise<string> {
  while (true) {
    const value = (await prompter.input(message, defaultValue)).trim();
    if (value) return value;
    prompter.note(`[setup] ${message} is required.`);
  }
}

function validateTokenValue(
  channel: Exclude<ChannelName, 'whatsapp' | 'gmail'>,
  key: string,
  value: string,
): string | null {
  const validator = TOKEN_VALIDATORS[channel]?.[key];
  if (!validator || validator.pattern.test(value.trim())) return null;
  return validator.help;
}

function validateChannelId(
  channel: Exclude<ChannelName, 'whatsapp' | 'gmail'>,
  value: string,
): string | null {
  const validator = CHANNEL_ID_VALIDATORS[channel];
  if (validator.pattern.test(value.trim())) return null;
  return validator.help;
}

async function promptValidatedInput(
  prompter: Prompter,
  message: string,
  validate: (value: string) => string | null,
  defaultValue = '',
): Promise<string> {
  while (true) {
    const value = await promptRequiredInput(prompter, message, defaultValue);
    const validationError = validate(value);
    if (!validationError) return value;
    prompter.note(`[setup] ${validationError}`);
  }
}

async function promptRequiredChannelSelection(
  prompter: Prompter,
): Promise<ChannelName[]> {
  while (true) {
    const selectedLabels = await prompter.multiselect(
      'Which messaging channels should NanoClaw enable?',
      CHANNELS.map((channel) => CHANNEL_LABELS[channel]),
      [0],
    );
    const selectedChannels = CHANNELS.filter((channel) =>
      selectedLabels.includes(CHANNEL_LABELS[channel]),
    );
    if (selectedChannels.length > 0) {
      return selectedChannels;
    }
    prompter.note('[setup] Select at least one messaging channel.');
  }
}

export function writeGmailOAuthKeys(
  targetDir: string,
  source: { type: 'path'; value: string } | { type: 'json'; value: string },
): void {
  fs.mkdirSync(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, 'gcp-oauth.keys.json');

  if (source.type === 'path') {
    fs.copyFileSync(source.value, targetPath);
    return;
  }

  const parsed = JSON.parse(source.value);
  fs.writeFileSync(targetPath, `${JSON.stringify(parsed, null, 2)}\n`);
}

export function getChannelCreationGuide(
  channel: Exclude<ChannelName, 'whatsapp' | 'gmail'>,
): string[] {
  return CHANNEL_CREATION_GUIDES[channel];
}

export function getChannelRegistrationGuide(
  channel: Exclude<ChannelName, 'whatsapp' | 'gmail'>,
): string[] {
  return CHANNEL_REGISTRATION_GUIDES[channel];
}

function formatEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function createPrompter(): Prompter {
  const rl = readline.createInterface({ input, output });

  async function promptLine(message: string): Promise<string> {
    const answer = await rl.question(message);
    return answer.trim();
  }

  return {
    async select(message, options, defaultIndex = 0) {
      output.write(`${message}\n`);
      options.forEach((option, index) => {
        output.write(`  ${index + 1}. ${option}\n`);
      });
      const answer = await promptLine(
        `Choose [${defaultIndex + 1}]: `,
      );
      if (!answer) return options[defaultIndex];

      const numeric = Number.parseInt(answer, 10);
      if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) {
        return options[numeric - 1];
      }

      const matched = options.find(
        (option) => option.toLowerCase() === answer.toLowerCase(),
      );
      if (matched) return matched;

      throw new Error(`Invalid selection: ${answer}`);
    },
    async multiselect(message, options, defaultIndexes = [0]) {
      output.write(`${message}\n`);
      options.forEach((option, index) => {
        output.write(`  ${index + 1}. ${option}\n`);
      });
      const defaultText = defaultIndexes.map((value) => value + 1).join(',');
      const answer = await promptLine(
        `Choose one or more [${defaultText}]: `,
      );
      const source = answer || defaultText;
      const selections = new Set<string>();

      for (const part of source.split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const numeric = Number.parseInt(trimmed, 10);
        if (
          Number.isInteger(numeric) &&
          numeric >= 1 &&
          numeric <= options.length
        ) {
          selections.add(options[numeric - 1]);
          continue;
        }
        const matched = options.find(
          (option) => option.toLowerCase() === trimmed.toLowerCase(),
        );
        if (!matched) {
          throw new Error(`Invalid selection: ${trimmed}`);
        }
        selections.add(matched);
      }

      return [...selections];
    },
    async input(message, defaultValue = '') {
      const suffix = defaultValue ? ` [${defaultValue}]` : '';
      const answer = await promptLine(`${message}${suffix}: `);
      return answer || defaultValue;
    },
    async confirm(message, defaultValue = true) {
      const suffix = defaultValue ? '[Y/n]' : '[y/N]';
      const answer = (await promptLine(`${message} ${suffix}: `)).toLowerCase();
      if (!answer) return defaultValue;
      return answer === 'y' || answer === 'yes';
    },
    note(message) {
      output.write(`${message}\n`);
    },
  };
}

function createDeps(projectRoot: string = process.cwd()): GuidedDeps {
  return {
    projectRoot,
    prompter: createPrompter(),
    async runCommand(command, args, options = {}) {
      return runProcess(command, args, projectRoot, options);
    },
  };
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  options: RunOptions,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let stdoutText = '';
    let stderrText = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdoutText += text;
      if (options.echoStdout !== false) {
        process.stdout.write(text);
      }
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderrText += text;
      if (options.echoStderr !== false) {
        process.stderr.write(text);
      }
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: stdoutText,
        stderr: stderrText,
      });
    });
  });
}

function ensureEnvFile(projectRoot: string): void {
  const envPath = path.join(projectRoot, '.env');
  if (fs.existsSync(envPath)) return;

  const examplePath = path.join(projectRoot, '.env.example');
  if (fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, envPath);
    return;
  }

  fs.writeFileSync(envPath, '');
}

function writeEnvUpdates(
  projectRoot: string,
  updates: Record<string, string>,
): void {
  ensureEnvFile(projectRoot);
  const envPath = path.join(projectRoot, '.env');
  const current = fs.readFileSync(envPath, 'utf-8');
  fs.writeFileSync(envPath, upsertEnvContent(current, updates));
}

function syncEnvSnapshot(projectRoot: string): void {
  const envPath = path.join(projectRoot, '.env');
  if (!fs.existsSync(envPath)) return;
  const target = path.join(projectRoot, 'data', 'env');
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(envPath, path.join(target, 'env'));
}

function channelFileExists(projectRoot: string, channel: ChannelName): boolean {
  const channelPath = path.join(projectRoot, 'src', 'channels', `${channel}.ts`);
  if (!fs.existsSync(channelPath)) return false;
  if (channel !== 'whatsapp') return true;

  return (
    fs.existsSync(path.join(projectRoot, 'src', 'whatsapp-auth.ts')) &&
    fs.existsSync(path.join(projectRoot, 'setup', 'whatsapp-auth.ts'))
  );
}

function getSetupCommandArgs(step: string, args: string[]): string[] {
  return ['tsx', 'setup/index.ts', '--step', step, '--', ...args];
}

function getDockerStartCommand(): { command: string; args: string[] } {
  if (process.getuid?.() === 0) {
    return { command: 'systemctl', args: ['start', 'docker'] };
  }
  return { command: 'sudo', args: ['systemctl', 'start', 'docker'] };
}

function getPrivilegedCommand(
  command: string,
  args: string[],
): { command: string; args: string[] } {
  if (process.getuid?.() === 0) {
    return { command, args };
  }
  return { command: 'sudo', args: [command, ...args] };
}

function pickLinuxPackageManager(environmentStatus: SetupStatus):
  | 'apt-get'
  | 'dnf'
  | 'yum'
  | null {
  if (environmentStatus.fields.APT_GET === 'installed') return 'apt-get';
  if (environmentStatus.fields.DNF === 'installed') return 'dnf';
  if (environmentStatus.fields.YUM === 'installed') return 'yum';
  return null;
}

function getHomebrewInstallCommand(): { command: string; args: string[] } {
  return {
    command: 'sh',
    args: [
      '-lc',
      'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
    ],
  };
}

function getNodeInstallCommand(
  environmentStatus: SetupStatus,
): { command: string; args: string[] } {
  if (environmentStatus.fields.PLATFORM === 'macos') {
    return { command: 'brew', args: ['install', 'node'] };
  }

  const packageManager = pickLinuxPackageManager(environmentStatus);
  if (packageManager === 'apt-get') {
    return getPrivilegedCommand('apt-get', ['install', '-y', 'nodejs', 'npm']);
  }
  if (packageManager === 'dnf') {
    return getPrivilegedCommand('dnf', ['install', '-y', 'nodejs', 'npm']);
  }
  if (packageManager === 'yum') {
    return getPrivilegedCommand('yum', ['install', '-y', 'nodejs', 'npm']);
  }

  throw new Error(
    'No supported package manager available to install Node.js and npm.',
  );
}

function getBuildToolsInstallCommand(
  environmentStatus: SetupStatus,
): { command: string; args: string[] } {
  if (environmentStatus.fields.PLATFORM === 'macos') {
    return { command: 'xcode-select', args: ['--install'] };
  }

  const packageManager = pickLinuxPackageManager(environmentStatus);
  if (packageManager === 'apt-get') {
    return getPrivilegedCommand('apt-get', [
      'install',
      '-y',
      'build-essential',
      'python3',
    ]);
  }
  if (packageManager === 'dnf') {
    return getPrivilegedCommand('dnf', [
      'install',
      '-y',
      'gcc',
      'gcc-c++',
      'make',
      'python3',
    ]);
  }
  if (packageManager === 'yum') {
    return getPrivilegedCommand('yum', [
      'install',
      '-y',
      'gcc',
      'gcc-c++',
      'make',
      'python3',
    ]);
  }

  throw new Error('No supported package manager available to install build tools.');
}

function getDockerInstallCommand(
  platform: string,
): { command: string; args: string[] } {
  if (platform === 'macos') {
    return { command: 'brew', args: ['install', '--cask', 'docker'] };
  }
  if (process.getuid?.() === 0) {
    return {
      command: 'sh',
      args: ['-lc', 'curl -fsSL https://get.docker.com | sh'],
    };
  }
  return {
    command: 'sudo',
    args: ['sh', '-lc', 'curl -fsSL https://get.docker.com | sh'],
  };
}

function getAppleContainerInstallCommand(): {
  command: string;
  args: string[];
} {
  return { command: 'brew', args: ['install', '--cask', 'container'] };
}

async function runSetupStep(
  deps: GuidedDeps,
  step: string,
  args: string[] = [],
): Promise<SetupStatus> {
  const result = await deps.runCommand('npx', getSetupCommandArgs(step, args));
  const status = parseLatestStatus(result.stdout);

  if (result.code !== 0) {
    const detail =
      status?.fields.ERROR ||
      status?.fields.STATUS ||
      result.stderr.trim() ||
      result.stdout.trim() ||
      `exit_${result.code}`;
    throw new Error(`${step} failed: ${detail}`);
  }

  if (!status) {
    throw new Error(`${step} failed: missing structured setup status`);
  }

  return status;
}

async function runRecoverableStage<T>(
  deps: GuidedDeps,
  stage: string,
  action: () => Promise<T>,
  options: RecoverableStageOptions = {},
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.prompter.note(`[setup] ${stage} failed: ${message}`);

    if (!options.remediate) {
      throw new Error(`${stage} failed: ${message}`);
    }

    deps.prompter.note(
      `[setup] ${options.retryLabel || `Retrying ${stage} after remediation.`}`,
    );
    await options.remediate();

    try {
      return await action();
    } catch (retryError) {
      const retryMessage =
        retryError instanceof Error ? retryError.message : String(retryError);
      throw new Error(`${stage} failed after retry: ${retryMessage}`);
    }
  }
}

async function applyChannelSkill(
  deps: GuidedDeps,
  channel: ChannelName,
): Promise<void> {
  if (channelFileExists(deps.projectRoot, channel)) return;

  deps.prompter.note(
    `[setup] Installing ${CHANNEL_LABELS[channel]} channel skill...`,
  );
  const result = await deps.runCommand('npx', [
    'tsx',
    'scripts/apply-skill.ts',
    `.agents/skills/add-${channel}`,
  ]);

  if (result.code !== 0) {
    throw new Error(
      `Failed to apply ${channel} skill: ${result.stderr || result.stdout}`,
    );
  }
}

function getWhatsAppSelfChatJid(projectRoot: string): string | null {
  try {
    const creds = JSON.parse(
      fs.readFileSync(
        path.join(projectRoot, 'store', 'auth', 'creds.json'),
        'utf-8',
      ),
    );
    const id = creds?.me?.id;
    if (typeof id !== 'string' || !id.includes('@')) return null;
    return `${id.split(':')[0].split('@')[0]}@s.whatsapp.net`;
  } catch {
    return null;
  }
}

async function configureTokenChannel(
  deps: GuidedDeps,
  setup: ChannelSetup,
): Promise<void> {
  const channel = setup.channel as Exclude<ChannelName, 'whatsapp'>;
  deps.prompter.note(`[setup] ${MANUAL_CHANNEL_HELP[channel]}`);
  if (channel !== 'gmail') {
    for (const line of getChannelCreationGuide(channel)) {
      deps.prompter.note(`[setup] ${line}`);
    }
  }

  const keys = TOKEN_ENV_KEYS[channel];
  const currentEnv = readProjectEnvValues(deps.projectRoot, keys);
  const hasExistingCredentials = keys.length > 0 && keys.every((key) => Boolean(currentEnv[key]));

  if (
    !hasExistingCredentials ||
    !(await deps.prompter.confirm(
      `Reuse existing ${CHANNEL_LABELS[channel]} credentials?`,
      true,
    ))
  ) {
    const updates: Record<string, string> = {};
    for (const key of keys) {
      const existing = currentEnv[key] || '';
      updates[key] = await promptValidatedInput(
        deps.prompter,
        `Enter ${key}`,
        (value) => validateTokenValue(channel, key, value),
        existing,
      );
    }
    writeEnvUpdates(deps.projectRoot, updates);
  }
  syncEnvSnapshot(deps.projectRoot);

  if (
    !setup.isMain &&
    !(await deps.prompter.confirm(
      `Register a ${CHANNEL_LABELS[channel]} chat now?`,
      true,
    ))
  ) {
    return;
  }

  if (channel !== 'gmail') {
    for (const line of getChannelRegistrationGuide(channel)) {
      deps.prompter.note(`[setup] ${line}`);
    }
  }

  const rawJid = await promptValidatedInput(
    deps.prompter,
    `Enter the ${CHANNEL_LABELS[channel]} chat or channel ID`,
    (value) => validateChannelId(channel, value),
  );
  const name = await promptRequiredInput(
    deps.prompter,
    `Enter a name for the ${CHANNEL_LABELS[channel]} chat`,
    setup.isMain ? `${CHANNEL_LABELS[channel]} main` : CHANNEL_LABELS[channel],
  );

  await runSetupStep(deps, 'register', [
    '--jid',
    normalizeChannelJid(channel, rawJid),
    '--name',
    name,
    '--trigger',
    setup.trigger,
    '--folder',
    setup.isMain
      ? `${channel}_main`
      : `${channel}_${sanitizeFolderSlug(name)}`,
    '--channel',
    channel,
    '--assistant-name',
    setup.assistantName,
    ...(setup.isMain ? ['--is-main', '--no-trigger-required'] : []),
  ]);
}

async function configureWhatsApp(
  deps: GuidedDeps,
  setup: ChannelSetup,
  environmentStatus: SetupStatus,
): Promise<void> {
  const authDir = path.join(deps.projectRoot, 'store', 'auth');
  const hasAuth =
    fs.existsSync(authDir) && fs.readdirSync(authDir).includes('creds.json');

  const shouldReuseAuth =
    hasAuth &&
    (await deps.prompter.confirm(
      'Reuse existing WhatsApp authentication?',
      true,
    ));

  if (!shouldReuseAuth) {
    fs.rmSync(authDir, { recursive: true, force: true });
    const isHeadless = environmentStatus.fields.IS_HEADLESS === 'true';
    const isWsl = environmentStatus.fields.IS_WSL === 'true';
    const methods = isHeadless && !isWsl
      ? ['Pairing code', 'QR code in terminal']
      : ['QR code in browser', 'Pairing code', 'QR code in terminal'];
    const selectedMethod = await deps.prompter.select(
      'How should WhatsApp authenticate?',
      methods,
      0,
    );

    if (selectedMethod === 'QR code in terminal') {
      deps.prompter.note(
        '[setup] Starting terminal QR flow. Scan the QR code and wait for the process to finish.',
      );
      const authResult = await deps.runCommand('npm', ['run', 'auth']);
      if (authResult.code !== 0) {
        throw new Error('WhatsApp authentication failed');
      }
    } else {
      const stepArgs = ['--method'];
      if (selectedMethod === 'Pairing code') {
        const phone = await promptRequiredInput(
          deps.prompter,
          'Enter your phone number with country code (no +)',
        );
        stepArgs.push('pairing-code', '--phone', phone);
      } else {
        stepArgs.push('qr-browser');
      }
      await runSetupStep(deps, 'whatsapp-auth', stepArgs);
    }
  }

  if (
    !setup.isMain &&
    !(await deps.prompter.confirm('Register a WhatsApp chat now?', true))
  ) {
    return;
  }

  const targetOptions = ['Self-chat', 'Existing group', 'Custom JID'];
  const target = await deps.prompter.select(
    'Where should NanoClaw listen on WhatsApp?',
    targetOptions,
    0,
  );

  let jid = '';
  let name = '';

  if (target === 'Self-chat') {
    const selfJid = getWhatsAppSelfChatJid(deps.projectRoot);
    if (!selfJid) {
      throw new Error('Unable to determine WhatsApp self-chat JID');
    }
    jid = selfJid;
    name = await promptRequiredInput(
      deps.prompter,
      'Name for the main chat',
      'WhatsApp main',
    );
  } else if (target === 'Existing group') {
    await runSetupStep(deps, 'groups');
    const listResult = await deps.runCommand('npx', getSetupCommandArgs('groups', ['--list']));
    if (listResult.code !== 0) {
      throw new Error('Failed to list WhatsApp groups');
    }
    const groups = parseGroupList(listResult.stdout);
    if (groups.length === 0) {
      throw new Error('No WhatsApp groups found after sync');
    }
    const selected = await deps.prompter.select(
      'Select a WhatsApp group to register',
      groups.map((group) => group.name),
      0,
    );
    const match = groups.find((group) => group.name === selected);
    if (!match) {
      throw new Error('Selected WhatsApp group not found');
    }
    jid = match.jid;
    name = match.name;
  } else {
    jid = normalizeChannelJid(
      'whatsapp',
      await promptRequiredInput(
        deps.prompter,
        'Enter the WhatsApp JID to register',
      ),
    );
    name = await promptRequiredInput(
      deps.prompter,
      'Enter a name for this WhatsApp chat',
    );
  }

  await runSetupStep(deps, 'register', [
    '--jid',
    jid,
    '--name',
    name,
    '--trigger',
    setup.trigger,
    '--folder',
    setup.isMain
      ? 'whatsapp_main'
      : `whatsapp_${sanitizeFolderSlug(name)}`,
    '--channel',
    'whatsapp',
    '--assistant-name',
    setup.assistantName,
    ...(setup.isMain ? ['--is-main', '--no-trigger-required'] : []),
  ]);
}

function resolveRuntime(environmentStatus: SetupStatus): string {
  if (environmentStatus.fields.PLATFORM === 'linux') return 'docker';
  if (environmentStatus.fields.PLATFORM !== 'macos') return '';
  if (environmentStatus.fields.APPLE_CONTAINER === 'installed') {
    return 'apple-container';
  }
  if (
    environmentStatus.fields.DOCKER === 'running' ||
    environmentStatus.fields.DOCKER === 'installed_not_running'
  ) {
    return 'docker';
  }
  return '';
}

async function selectRuntime(
  deps: GuidedDeps,
  environmentStatus: SetupStatus,
): Promise<RuntimeChoice> {
  if (environmentStatus.fields.PLATFORM === 'linux') return 'docker';

  const hasApple = environmentStatus.fields.APPLE_CONTAINER === 'installed';
  const hasDocker =
    environmentStatus.fields.DOCKER === 'running' ||
    environmentStatus.fields.DOCKER === 'installed_not_running';

  if (hasApple && hasDocker) {
    const choice = await deps.prompter.select(
      'Which container runtime should NanoClaw use?',
      ['Docker', 'Apple Container'],
      0,
    );
    return choice === 'Apple Container' ? 'apple-container' : 'docker';
  }

  if (!hasApple && !hasDocker) {
    const choice = await deps.prompter.select(
      'No container runtime is installed. Which one should NanoClaw install?',
      ['Docker', 'Apple Container'],
      0,
    );
    return choice === 'Apple Container' ? 'apple-container' : 'docker';
  }

  const fallback = resolveRuntime(environmentStatus);
  if (!fallback) {
    throw new Error(
      'No supported container runtime detected. Start Docker or install Apple Container, then rerun ./scripts/setup.sh',
    );
  }
  return fallback as RuntimeChoice;
}

async function installRuntimeIfMissing(
  deps: GuidedDeps,
  environmentStatus: SetupStatus,
  runtime: RuntimeChoice,
): Promise<SetupStatus> {
  if (
    runtime === 'docker' &&
    environmentStatus.fields.DOCKER === 'not_found'
  ) {
    deps.prompter.note('[setup] Docker is missing. Installing it now.');
    const install = getDockerInstallCommand(environmentStatus.fields.PLATFORM);
    const result = await deps.runCommand(install.command, install.args);
    if (result.code !== 0) {
      throw new Error(`Docker install failed: ${result.stderr || result.stdout}`);
    }
    const refreshed = await runSetupStep(deps, 'environment');
    if (refreshed.fields.DOCKER === 'not_found') {
      throw new Error('Docker is still missing after the install attempt');
    }
    return refreshed;
  }

  if (
    runtime === 'apple-container' &&
    environmentStatus.fields.APPLE_CONTAINER === 'not_found'
  ) {
    deps.prompter.note('[setup] Apple Container is missing. Installing it now.');
    const install = getAppleContainerInstallCommand();
    const result = await deps.runCommand(install.command, install.args);
    if (result.code !== 0) {
      throw new Error(
        `Apple Container install failed: ${result.stderr || result.stdout}`,
      );
    }
    const refreshed = await runSetupStep(deps, 'environment');
    if (refreshed.fields.APPLE_CONTAINER === 'not_found') {
      throw new Error(
        'Apple Container is still missing after the install attempt',
      );
    }
    return refreshed;
  }

  return environmentStatus;
}

async function installSystemDependenciesIfMissing(
  deps: GuidedDeps,
  environmentStatus: SetupStatus,
): Promise<SetupStatus> {
  let current = environmentStatus;

  const needsHomebrew =
    current.fields.PLATFORM === 'macos' &&
    current.fields.HOMEBREW !== 'installed' &&
    (
      current.fields.NODE === 'not_found' ||
      current.fields.NPM === 'not_found' ||
      current.fields.DOCKER === 'not_found' ||
      current.fields.APPLE_CONTAINER === 'not_found'
    );
  if (needsHomebrew) {
    deps.prompter.note('[setup] Homebrew is missing. Installing it now.');
    const install = getHomebrewInstallCommand();
    const result = await deps.runCommand(install.command, install.args);
    if (result.code !== 0) {
      throw new Error(
        `Homebrew install failed: ${result.stderr || result.stdout}`,
      );
    }
    current = await runSetupStep(deps, 'environment');
    if (current.fields.HOMEBREW !== 'installed') {
      throw new Error('Homebrew is still missing after the install attempt');
    }
  }

  if (current.fields.BUILD_TOOLS === 'not_found') {
    deps.prompter.note('[setup] Required build tools are missing. Installing them now.');
    const install = getBuildToolsInstallCommand(current);
    const result = await deps.runCommand(install.command, install.args);
    if (result.code !== 0) {
      throw new Error(
        `Build tools install failed: ${result.stderr || result.stdout}`,
      );
    }
    current = await runSetupStep(deps, 'environment');
    if (current.fields.BUILD_TOOLS !== 'ready') {
      throw new Error(
        'Build tools are still unavailable after the install attempt',
      );
    }
  }

  if (
    current.fields.NODE === 'not_found' ||
    current.fields.NPM === 'not_found'
  ) {
    deps.prompter.note('[setup] Node.js or npm is missing. Installing them now.');
    const install = getNodeInstallCommand(current);
    const result = await deps.runCommand(install.command, install.args);
    if (result.code !== 0) {
      throw new Error(
        `Node.js install failed: ${result.stderr || result.stdout}`,
      );
    }
    current = await runSetupStep(deps, 'environment');
    if (
      current.fields.NODE !== 'installed' ||
      current.fields.NPM !== 'installed'
    ) {
      throw new Error(
        'Node.js or npm is still missing after the install attempt',
      );
    }
  }

  return current;
}

async function ensureRuntimeReady(
  deps: GuidedDeps,
  environmentStatus: SetupStatus,
  runtime: RuntimeChoice,
): Promise<SetupStatus> {
  if (runtime === 'docker') {
    if (environmentStatus.fields.DOCKER === 'running') {
      return environmentStatus;
    }
    if (environmentStatus.fields.DOCKER !== 'installed_not_running') {
      return environmentStatus;
    }

    deps.prompter.note('[setup] Docker is installed but not running. Starting it now.');
    if (environmentStatus.fields.PLATFORM === 'macos') {
      await deps.runCommand('open', ['-a', 'Docker']);
    } else {
      const start = getDockerStartCommand();
      await deps.runCommand(start.command, start.args);
    }

    const refreshed = await runSetupStep(deps, 'environment');
    if (refreshed.fields.DOCKER !== 'running') {
      throw new Error('Docker is still not running after the start attempt');
    }
    return refreshed;
  }

  const status = await deps.runCommand('container', ['system', 'status']);
  if (status.code === 0) {
    return environmentStatus;
  }

  deps.prompter.note('[setup] Apple Container runtime is installed but not started. Starting it now.');
  const start = await deps.runCommand('container', ['system', 'start']);
  if (start.code !== 0) {
    throw new Error(
      `Apple Container failed to start: ${start.stderr || start.stdout}`,
    );
  }
  return environmentStatus;
}

function buildChannelSetups(
  selectedChannels: ChannelName[],
  mainChannel: ChannelName,
  assistantName: string,
  trigger: string,
): ChannelSetup[] {
  return selectedChannels.map((channel) => ({
    channel,
    isMain: channel === mainChannel,
    assistantName,
    trigger,
  }));
}

async function configureMounts(deps: GuidedDeps): Promise<void> {
  const allowExternal = await deps.prompter.confirm(
    'Allow agent access to external directories?',
    false,
  );
  if (!allowExternal) {
    await runSetupStep(deps, 'mounts', ['--empty']);
    return;
  }

  const rawPaths = await deps.prompter.input(
    'Enter absolute paths, separated by commas',
  );
  const allowedRoots = rawPaths
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  await runSetupStep(deps, 'mounts', [
    '--json',
    JSON.stringify({
      allowedRoots,
      blockedPatterns: [],
      nonMainReadOnly: true,
    }),
  ]);
}

async function maybeConfigureGmail(deps: GuidedDeps): Promise<boolean> {
  const currentMode = detectConfiguredGmailMode(deps.projectRoot);
  const plan = await planGmailConfiguration(deps, currentMode);
  const gmailMode = plan.mode;

  if (gmailMode === 'disabled') return false;

  if (plan.codeChanged) {
    if (gmailMode === 'tool-only') {
      deps.prompter.note(
        '[setup] Gmail tool-only mode enables Gmail tools without inbox polling or a Gmail channel.',
      );
      if (currentMode === 'channel') {
        removeGmailChannelFiles(deps.projectRoot);
      }
      applyGmailToolOnlyMode(deps.projectRoot);
    } else {
      deps.prompter.note(
        '[setup] Gmail channel mode adds inbox polling and email-triggered agent replies.',
      );
      await applyChannelSkill(deps, 'gmail' as never);
      ensureMainGroupEmailGuidance(deps.projectRoot);
      upsertAppliedSkill(
        deps.projectRoot,
        'gmail',
        [
          'src/channels/gmail.ts',
          'src/container-runner.ts',
          'container/agent-runner/src/index.ts',
        ],
        { mode: 'channel' },
      );
    }
  } else if (gmailMode === 'tool-only') {
    deps.prompter.note(
      plan.reauthorize
        ? '[setup] Reauthorizing Gmail tool-only mode.'
        : '[setup] Keeping existing Gmail tool-only mode.',
    );
  } else {
    deps.prompter.note(
      plan.reauthorize
        ? '[setup] Reauthorizing Gmail channel mode.'
        : '[setup] Keeping existing Gmail channel mode.',
    );
  }

  const gmailDir = getGmailConfigDir();
  const keysPath = path.join(gmailDir, 'gcp-oauth.keys.json');
  const credentialsPath = path.join(gmailDir, 'credentials.json');
  const hasExistingAuth =
    fs.existsSync(keysPath) && fs.existsSync(credentialsPath);
  const shouldReuseAuth =
    !plan.reauthorize &&
    hasExistingAuth &&
    (await deps.prompter.confirm('Reuse existing Gmail authorization?', true));

  if (!shouldReuseAuth && fs.existsSync(credentialsPath)) {
    fs.rmSync(credentialsPath, { force: true });
  }

  if (!fs.existsSync(keysPath)) {
    const sourceKind = await deps.prompter.select(
      'How do you want to provide the Gmail OAuth client JSON?',
      ['File path', 'Paste JSON'],
      0,
    );
    if (sourceKind === 'File path') {
      const sourcePath = await promptRequiredInput(
        deps.prompter,
        'Enter the full path to gcp-oauth.keys.json',
      );
      writeGmailOAuthKeys(gmailDir, { type: 'path', value: sourcePath });
    } else {
      const jsonText = await promptRequiredInput(
        deps.prompter,
        'Paste the Gmail OAuth client JSON',
      );
      writeGmailOAuthKeys(gmailDir, { type: 'json', value: jsonText });
    }
  }

  if (!shouldReuseAuth) {
    deps.prompter.note(
      '[setup] Starting Gmail OAuth authorization in the browser.',
    );
    const authResult = await deps.runCommand('npx', [
      '-y',
      '@gongrzhe/server-gmail-autoauth-mcp',
      'auth',
    ]);
    if (authResult.code !== 0) {
      throw new Error(
        `Gmail authorization failed: ${authResult.stderr || authResult.stdout}`,
      );
    }
  }

  if (gmailMode === 'channel') {
    deps.prompter.note(
      '[setup] Gmail channel mode delivers incoming emails into the registered main chat.',
    );
  }
  return plan.codeChanged;
}

export async function runGuidedSetup(deps: GuidedDeps): Promise<void> {
  deps.prompter.note('[setup] Starting guided NanoClaw setup');

  let environmentStatus = await runRecoverableStage(
    deps,
    'environment check',
    () => runSetupStep(deps, 'environment'),
  );
  environmentStatus = await runRecoverableStage(
    deps,
    'system dependency bootstrap',
    () => installSystemDependenciesIfMissing(deps, environmentStatus),
  );
  const runtime = await runRecoverableStage(
    deps,
    'runtime selection',
    () => selectRuntime(deps, environmentStatus),
  );
  environmentStatus = await runRecoverableStage(
    deps,
    'runtime installation',
    () => installRuntimeIfMissing(deps, environmentStatus, runtime),
  );
  environmentStatus = await runRecoverableStage(
    deps,
    'runtime startup',
    () => ensureRuntimeReady(deps, environmentStatus, runtime),
  );

  if (
    runtime === 'apple-container' &&
    !isAppleContainerConverted(deps.projectRoot)
  ) {
    deps.prompter.note(
      '[setup] Converting this checkout to Apple Container runtime.',
    );
    await runRecoverableStage(deps, 'Apple Container conversion', async () => {
      const result = await deps.runCommand('npx', [
        'tsx',
        'scripts/apply-skill.ts',
        '.agents/skills/convert-to-apple-container',
      ]);
      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout);
      }
    });
  }

  await runRecoverableStage(
    deps,
    'container build',
    () => runSetupStep(deps, 'container', ['--runtime', runtime]),
    {
      retryLabel:
        'Clearing stale per-group agent runner copies, then retrying the container build.',
      remediate: async () => {
        clearStaleAgentRunnerCopies(deps.projectRoot);
      },
    },
  );

  const projectEnv = readProjectEnvValues(deps.projectRoot, ['ASSISTANT_NAME']);
  const assistantName = await promptRequiredInput(
    deps.prompter,
    'Assistant name',
    projectEnv.ASSISTANT_NAME || 'Andy',
  );
  const trigger = await promptRequiredInput(
    deps.prompter,
    'Trigger word',
    `@${assistantName}`,
  );

  const selectedChannels = await promptRequiredChannelSelection(deps.prompter);
  const mainChannelLabel =
    selectedChannels.length === 1
      ? CHANNEL_LABELS[selectedChannels[0]]
      : await deps.prompter.select(
          'Which channel should be the main control chat?',
          selectedChannels.map((channel) => CHANNEL_LABELS[channel]),
          0,
        );
  const mainChannel = CHANNELS.find(
    (channel) => CHANNEL_LABELS[channel] === mainChannelLabel,
  );
  if (!mainChannel) {
    throw new Error('No main channel selected');
  }

  for (const setup of buildChannelSetups(
    selectedChannels,
    mainChannel,
    assistantName,
    trigger,
  )) {
    await runRecoverableStage(
      deps,
      `${CHANNEL_LABELS[setup.channel]} skill install`,
      () => applyChannelSkill(deps, setup.channel),
    );
    if (setup.channel === 'whatsapp') {
      await runRecoverableStage(
        deps,
        'WhatsApp authentication and registration',
        () => configureWhatsApp(deps, setup, environmentStatus),
      );
    } else {
      await runRecoverableStage(
        deps,
        `${CHANNEL_LABELS[setup.channel]} credential and registration`,
        () => configureTokenChannel(deps, setup),
      );
    }
  }

  const gmailChanged = await runRecoverableStage(
    deps,
    'Gmail integration',
    () => maybeConfigureGmail(deps),
  );
  if (gmailChanged) {
    deps.prompter.note(
      '[setup] Refreshing container assets so Gmail changes reach future sessions.',
    );
    clearStaleAgentRunnerCopies(deps.projectRoot);
    await runRecoverableStage(
      deps,
      'container refresh',
      () => runSetupStep(deps, 'container', ['--runtime', runtime]),
      {
        retryLabel:
          'Retrying the container refresh after clearing stale per-group agent runner copies.',
        remediate: async () => {
          clearStaleAgentRunnerCopies(deps.projectRoot);
        },
      },
    );
  }
  await runRecoverableStage(deps, 'mount configuration', () =>
    configureMounts(deps),
  );
  await runRecoverableStage(
    deps,
    'service setup',
    () => runSetupStep(deps, 'service'),
    {
      retryLabel:
        'Retrying service setup after rebuilding the container image.',
      remediate: async () => {
        await runSetupStep(deps, 'container', ['--runtime', runtime]);
      },
    },
  );
  await runRecoverableStage(
    deps,
    'verification',
    () => runSetupStep(deps, 'verify'),
    {
      retryLabel:
        'Retrying verification after rerunning service setup.',
      remediate: async () => {
        await runSetupStep(deps, 'service');
      },
    },
  );

  deps.prompter.note('[setup] Guided setup completed');
}

export async function run(_args: string[]): Promise<void> {
  await runGuidedSetup(createDeps());
}

const currentFile = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  run(process.argv.slice(2)).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[setup] ${message}`);
    process.exit(1);
  });
}
