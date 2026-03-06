<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  An AI assistant that runs agents securely in their own containers. Lightweight, built to be easily understood and completely customized for your needs.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>
Using Codex (default backend), NanoClaw can dynamically rewrite its code to customize its feature set for your needs.

**New:** First AI assistant to support [Agent Swarms](https://code.claude.com/docs/en/agent-teams). Spin up teams of agents that collaborate in your chat.

## Why I Built NanoClaw

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project, but I wouldn't have been able to sleep if I had given complex software I didn't understand full access to my life. OpenClaw has nearly half a million lines of code, 53 config files, and 70+ dependencies. Its security is at the application level (allowlists, pairing codes) rather than true OS-level isolation. Everything runs in one Node process with shared memory.

NanoClaw provides that same core functionality, but in a codebase small enough to understand: one process and a handful of files. Agents run in their own Linux containers with filesystem isolation, not merely behind permission checks.

## Quick Start

```bash
git clone https://github.com/qwibitai/nanoclaw.git
cd NanoClaw
./scripts/setup.sh
```

`./scripts/setup.sh` launches a guided terminal setup. It now self-heals missing system dependencies before setup continues: Homebrew (macOS), build tools, Node.js/npm, and the selected container runtime. After bootstrap it can choose Docker vs Apple Container, install a channel skill, collect credentials, run channel authentication, register the first chat, optionally enable Gmail integration, configure mounts, start the service, and finish with `verify`.

Run verification with:

```bash
./scripts/verify.sh
```

You can still drive setup with Codex CLI:

```bash
codex exec --full-auto "./scripts/setup.sh"
codex exec --full-auto "./scripts/verify.sh"
```

Credential priority during the migration window:
`CODEX_API_KEY > OPENAI_API_KEY > group .codex/auth.json`

Codex runtime notes:
- Legacy `ANTHROPIC_*` / `CLAUDE_CODE_*` credentials are not used by `AGENT_BACKEND=codex` (they remain for Claude rollback only).
- If host `~/.codex/auth.json` exists and a group has no `data/sessions/<group>/.codex/auth.json`, NanoClaw seeds it on first run (`configured_pending_seed` state in verify).
- Keyring-only Codex auth is not auto-imported; use `CODEX_API_KEY` / `OPENAI_API_KEY` or switch Codex CLI credential store to file-based auth.
- If startup fails because no channels are configured, credentials are incomplete, or the container runtime is unavailable, NanoClaw prints guided recovery messages pointing back to `./scripts/setup.sh` and `./scripts/verify.sh`.

Legacy skills to script mapping:

| Legacy skill command | Script command |
| --- | --- |
| `/setup` | `./scripts/setup.sh` |
| `/debug` | `./scripts/verify.sh` |

## Philosophy

**Small enough to understand.** One process, a few source files and no microservices. If you want to understand the full NanoClaw codebase, ask your coding agent (Codex by default) to walk you through it.

**Secure by isolation.** Agents run in Linux containers (Apple Container on macOS, or Docker) and they can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for the individual user.** NanoClaw isn't a monolithic framework; it's software that fits each user's exact needs. Instead of becoming bloatware, NanoClaw is designed to be bespoke. You make your own fork and have Codex modify it to match your needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that it's safe to make changes.

**AI-native.**
- Guided terminal setup via `./scripts/setup.sh` instead of a web installer.
- Structured bootstrap status blocks for system dependency repair and setup stages.
- No monitoring dashboard; ask the agent what's happening.
- No debugging tools; describe the problem and let the agent patch it.

**Skills over features.** Instead of adding features (e.g. support for Telegram) to the codebase, contributors submit skills like `/add-telegram` that transform your fork. You end up with clean code that does exactly what you need.

**Best harness, best model.** NanoClaw now defaults to a Codex wrapper runtime, with a controlled Claude rollback window (`AGENT_BACKEND=claude`) for migration safety.

## What It Supports

- **Multi-channel messaging** - Talk to your assistant from WhatsApp, Telegram, Discord, Slack, or Gmail. `./scripts/setup.sh` can install and configure WhatsApp, Telegram, Slack, Discord, and optional Gmail integration for you; manual skills still work when you want explicit control.
- **Isolated group context** - Each group has its own `CLAUDE.md` memory, isolated filesystem, and runs in its own container sandbox with only that filesystem mounted to it.
- **Main channel** - Your private channel (self-chat) for admin control; every group is completely isolated
- **Scheduled tasks** - Recurring jobs that run the configured backend and can message you back
- **Web access** - Search and fetch content from the Web
- **Container isolation** - Agents are sandboxed in Apple Container (macOS) or Docker (macOS/Linux)
- **Agent Swarms** - Spin up teams of specialized agents that collaborate on complex tasks. NanoClaw is the first personal AI assistant to support agent swarms.
- **Optional integrations** - Add Gmail (`/add-gmail`) and more via skills

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am (has access to my Obsidian vault folder)
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

From the main channel (your self-chat), you can manage groups and tasks:
```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

## Customizing

NanoClaw doesn't use configuration files. To make changes, tell Codex (or your coding agent) what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that an agent can safely modify it.

## Contributing

**Don't add features. Add skills.**

If you want to add Telegram support, don't create a PR that adds Telegram alongside WhatsApp. Instead, contribute a skill file (`.claude/skills/add-telegram/SKILL.md`) that teaches the migration agent workflow how to transform a NanoClaw installation to use Telegram.

Users then run `/add-telegram` on their fork and get clean code that does exactly what they need, not a bloated system trying to support every use case.

### RFS (Request for Skills)

Skills we'd like to see:

**Communication Channels**
- `/add-signal` - Add Signal as a channel

**Session Management**
- `/clear` - Add a `/clear` command that compacts the conversation (summarizes context while preserving critical information in the same session).

## Requirements

- macOS or Linux
- Node.js 20+
- [Codex CLI](https://github.com/openai/codex)
- [Apple Container](https://github.com/apple/container) (macOS) or [Docker](https://docker.com/products/docker-desktop) (macOS/Linux)

## Architecture

```
Channels --> SQLite --> Polling loop --> Container (Codex wrapper / Claude fallback) --> Response
```

Single Node.js process. Channels are added via skills and self-register at startup — the orchestrator connects whichever ones have credentials present. Agents execute in isolated Linux containers with filesystem isolation. Only mounted directories are accessible. Per-group message queue with concurrency control. IPC via filesystem.

For the full architecture details, see [docs/SPEC.md](docs/SPEC.md).

Key files:
- `src/index.ts` - Orchestrator: state, message loop, agent invocation
- `src/channels/registry.ts` - Channel registry (self-registration at startup)
- `src/ipc.ts` - IPC watcher and task processing
- `src/router.ts` - Message formatting and outbound routing
- `src/group-queue.ts` - Per-group queue with global concurrency limit
- `src/container-runner.ts` - Spawns streaming agent containers
- `src/task-scheduler.ts` - Runs scheduled tasks
- `src/db.ts` - SQLite operations (messages, groups, sessions, state)
- `groups/*/CLAUDE.md` - Per-group memory instructions

## FAQ

**Why Docker?**

Docker provides cross-platform support (macOS, Linux and even Windows via WSL2) and a mature ecosystem. On macOS, you can optionally switch to Apple Container via `/convert-to-apple-container` for a lighter-weight native runtime.

**Can I run this on Linux?**

Yes. Docker is the default runtime and works on both macOS and Linux. Run `./scripts/setup.sh`.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. You should still review what you're running, but the codebase is small enough that you actually can. See [docs/SECURITY.md](docs/SECURITY.md) for the full security model.

**Why no configuration files?**

We don't want configuration sprawl. Every user should customize NanoClaw so that the code does exactly what they want, rather than configuring a generic system. If you prefer having config files, you can tell Claude to add them.

**Can I use third-party or open-source models?**

Yes. NanoClaw supports multiple model endpoints. Use credential priority:

`CODEX_API_KEY > OPENAI_API_KEY > ANTHROPIC_* > CLAUDE_CODE_*`

For custom endpoints, configure your provider-specific environment variables.

Legacy Anthropic-compatible settings remain supported during the rollback window.

**How do I debug issues?**

Ask your coding agent. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?"

**Why isn't the setup working for me?**

If setup fails, run `./scripts/verify.sh` and inspect logs. During migration, you can also test rollback behavior with `AGENT_BACKEND=claude`.

**What changes will be accepted into the codebase?**

Only security fixes, bug fixes, and clear improvements will be accepted to the base configuration. That's all.

Everything else (new capabilities, OS compatibility, hardware support, enhancements) should be contributed as skills.

This keeps the base system minimal and lets every user customize their installation without inheriting features they don't want.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for breaking changes and migration notes.

## License

MIT
