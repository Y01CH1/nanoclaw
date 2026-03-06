/**
 * Step: environment — Detect OS, Node, container runtimes, existing config.
 * Replaces 01-check-environment.sh
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../src/config.js';
import { logger } from '../src/logger.js';
import { commandExists, getPlatform, isHeadless, isWSL } from './platform.js';
import { emitStatus } from './status.js';

type DependencyPresence = 'installed' | 'not_found';
type BuildToolsStatus = 'ready' | 'not_found';

export function detectPackageManagers(): Record<
  'HOMEBREW' | 'APT_GET' | 'DNF' | 'YUM',
  DependencyPresence
> {
  return {
    HOMEBREW: commandExists('brew') ? 'installed' : 'not_found',
    APT_GET: commandExists('apt-get') ? 'installed' : 'not_found',
    DNF: commandExists('dnf') ? 'installed' : 'not_found',
    YUM: commandExists('yum') ? 'installed' : 'not_found',
  };
}

export function detectBuildTools(
  platform: 'linux' | 'macos' | 'unknown',
  execCommand: typeof execSync = execSync,
): BuildToolsStatus {
  if (platform === 'macos') {
    if (!commandExists('xcode-select')) return 'not_found';
    try {
      const value = execCommand('xcode-select -p', { encoding: 'utf-8' }).trim();
      return value ? 'ready' : 'not_found';
    } catch {
      return 'not_found';
    }
  }

  if (platform === 'linux') {
    const hasCompiler = commandExists('gcc') || commandExists('clang');
    const hasCppCompiler = commandExists('g++') || commandExists('clang++');
    const hasMake = commandExists('make');
    const hasPython = commandExists('python3');
    return hasCompiler && hasCppCompiler && hasMake && hasPython
      ? 'ready'
      : 'not_found';
  }

  return 'not_found';
}

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();

  logger.info('Starting environment check');

  const platform = getPlatform();
  const wsl = isWSL();
  const headless = isHeadless();
  const node = commandExists('node') ? 'installed' : 'not_found';
  const npm = commandExists('npm') ? 'installed' : 'not_found';
  const packageManagers = detectPackageManagers();
  const buildTools = detectBuildTools(platform);

  // Check Apple Container
  let appleContainer: 'installed' | 'not_found' = 'not_found';
  if (commandExists('container')) {
    appleContainer = 'installed';
  }

  // Check Docker
  let docker: 'running' | 'installed_not_running' | 'not_found' = 'not_found';
  if (commandExists('docker')) {
    try {
      execSync('docker info', { stdio: 'ignore' });
      docker = 'running';
    } catch {
      docker = 'installed_not_running';
    }
  }

  // Check existing config
  const hasEnv = fs.existsSync(path.join(projectRoot, '.env'));

  const authDir = path.join(projectRoot, 'store', 'auth');
  const hasAuth = fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;

  let hasRegisteredGroups = false;
  // Check JSON file first (pre-migration)
  if (fs.existsSync(path.join(projectRoot, 'data', 'registered_groups.json'))) {
    hasRegisteredGroups = true;
  } else {
    // Check SQLite directly using better-sqlite3 (no sqlite3 CLI needed)
    const dbPath = path.join(STORE_DIR, 'messages.db');
    if (fs.existsSync(dbPath)) {
      try {
        const db = new Database(dbPath, { readonly: true });
        const row = db
          .prepare('SELECT COUNT(*) as count FROM registered_groups')
          .get() as { count: number };
        if (row.count > 0) hasRegisteredGroups = true;
        db.close();
      } catch {
        // Table might not exist yet
      }
    }
  }

  logger.info(
    {
      platform,
      wsl,
      node,
      npm,
      buildTools,
      ...packageManagers,
      appleContainer,
      docker,
      hasEnv,
      hasAuth,
      hasRegisteredGroups,
    },
    'Environment check complete',
  );

  emitStatus('CHECK_ENVIRONMENT', {
    PLATFORM: platform,
    IS_WSL: wsl,
    IS_HEADLESS: headless,
    NODE: node,
    NPM: npm,
    BUILD_TOOLS: buildTools,
    ...packageManagers,
    APPLE_CONTAINER: appleContainer,
    DOCKER: docker,
    HAS_ENV: hasEnv,
    HAS_AUTH: hasAuth,
    HAS_REGISTERED_GROUPS: hasRegisteredGroups,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
