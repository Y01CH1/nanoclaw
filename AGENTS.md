# Repository Guidelines

## Project Structure & Module Organization
Core runtime code lives in `src/` (single-process orchestrator, routing, scheduler, container runner, and SQLite access). Setup and service bootstrap code is in `setup/`. Skill transformation logic is in `skills-engine/`, with helper scripts in `scripts/`. Container runtime assets are in `container/`, static images in `assets/`, and architecture/security notes in `docs/`.

Tests are colocated by area:
- `src/**/*.test.ts`
- `setup/**/*.test.ts`
- `skills-engine/__tests__/*.test.ts`

## Build, Test, and Development Commands
- `npm run dev`: run NanoClaw from source with `tsx`.
- `npm run build`: compile TypeScript to `dist/`.
- `npm run start`: run compiled output (`dist/index.js`).
- `npm run typecheck`: strict TS check without emitting files.
- `npm run test`: run all Vitest suites once.
- `npm run test:watch`: run tests in watch mode.
- `npm run format:check`: verify formatting in `src/**/*.ts`.
- `npm run format:fix`: apply Prettier formatting.
- `./container/build.sh`: rebuild the agent container image.

## Coding Style & Naming Conventions
Use TypeScript with ES modules and `strict` compiler settings. Prettier is the formatter (`.prettierrc`: single quotes); keep default Prettier indentation and avoid manual style drift. Use descriptive, kebab-case file names (for example, `container-runner.ts`, `group-queue.test.ts`). Keep modules focused and prefer small pure helpers for parsing/routing logic.

## Testing Guidelines
Framework: Vitest (`vitest.config.ts`). Name tests `*.test.ts` and place them alongside the relevant package area. Add or update tests for every behavior change, especially queueing, scheduling, IPC, and container boundary logic. Run `npm run test` plus `npm run typecheck` before opening a PR.

## Commit & Pull Request Guidelines
Follow Conventional Commit style seen in history: `feat: ...`, `fix(scope): ...`, `chore: ...`, `docs: ...`. Keep commits scoped to one concern.

For PRs, include:
- clear problem statement and change summary
- linked issue(s) when applicable
- test evidence (command output summary)
- migration notes for behavior changes

Project policy: core accepts bug fixes, security fixes, and simplifications. New capabilities should generally be contributed as skills (not core source expansion).
