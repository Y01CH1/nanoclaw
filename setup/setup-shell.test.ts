import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

function writeExecutable(
  dir: string,
  name: string,
  body: string,
): void {
  const target = path.join(dir, name);
  fs.writeFileSync(target, body, { mode: 0o755 });
}

function createCommandLogger(
  binDir: string,
  command: string,
  behavior = 'exit 0',
): void {
  writeExecutable(
    binDir,
    command,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "${command} $*" >> "\${SETUP_TEST_LOG}"
${behavior}
`,
  );
}

describe('scripts/setup.sh', () => {
  it('installs linux build tools and node before npm bootstrap when missing', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-setup-sh-'));
    const projectRoot = path.join(tempDir, 'project');
    const binDir = path.join(tempDir, 'bin');
    fs.mkdirSync(path.join(projectRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    const logPath = path.join(tempDir, 'commands.log');
    fs.copyFileSync(
      path.join(process.cwd(), 'scripts', 'setup.sh'),
      path.join(projectRoot, 'scripts', 'setup.sh'),
    );

    createCommandLogger(binDir, 'sudo');
    createCommandLogger(binDir, 'apt-get');
    createCommandLogger(binDir, 'npm');

    const result = spawnSync('bash', ['scripts/setup.sh'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:/bin:/usr/bin`,
        SETUP_TEST_LOG: logPath,
        SETUP_PLATFORM_OVERRIDE: 'linux',
        SETUP_HAS_NODE: '0',
        SETUP_HAS_NPM: '0',
        SETUP_HAS_GCC: '0',
        SETUP_HAS_G__: '0',
        SETUP_HAS_CLANG: '0',
        SETUP_HAS_CLANG__: '0',
        SETUP_HAS_MAKE: '0',
        SETUP_HAS_PYTHON3: '0',
        SETUP_HAS_APT_GET: '1',
        SETUP_HAS_DNF: '0',
        SETUP_HAS_YUM: '0',
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('=== NANOCLAW SETUP: BOOTSTRAP_SYSTEM_DEPS ===');
    expect(result.stdout).toContain('=== NANOCLAW SETUP: BOOTSTRAP_BUILD_TOOLS ===');
    expect(result.stdout).toContain('=== NANOCLAW SETUP: BOOTSTRAP_NODE_RUNTIME ===');
    const commands = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(commands).toContain('sudo apt-get install -y build-essential python3');
    expect(commands).toContain('sudo apt-get install -y nodejs npm');
    expect(commands).toContain('npm install');
    expect(commands).toContain('npm run setup -- --step guided --');
  });

  it('skips dependency installs when the toolchain is already present', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-setup-sh-'));
    const projectRoot = path.join(tempDir, 'project');
    const binDir = path.join(tempDir, 'bin');
    fs.mkdirSync(path.join(projectRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    const logPath = path.join(tempDir, 'commands.log');
    fs.copyFileSync(
      path.join(process.cwd(), 'scripts', 'setup.sh'),
      path.join(projectRoot, 'scripts', 'setup.sh'),
    );
    fs.mkdirSync(path.join(projectRoot, 'node_modules'), { recursive: true });

    createCommandLogger(binDir, 'sudo');
    createCommandLogger(binDir, 'apt-get');
    createCommandLogger(binDir, 'npm');

    const result = spawnSync('bash', ['scripts/setup.sh'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:/bin:/usr/bin`,
        SETUP_TEST_LOG: logPath,
        SETUP_PLATFORM_OVERRIDE: 'linux',
        SETUP_HAS_NODE: '1',
        SETUP_HAS_NPM: '1',
        SETUP_HAS_GCC: '1',
        SETUP_HAS_G__: '1',
        SETUP_HAS_MAKE: '1',
        SETUP_HAS_PYTHON3: '1',
        SETUP_HAS_APT_GET: '1',
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('STATUS: skipped');
    const commands = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(commands).toEqual(['npm run setup -- --step guided --']);
  });
});
