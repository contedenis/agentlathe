# Developing

How to work on the agentlathe codebase — scripts, test levels, and conventions. For getting it running in the first place, see the [quickstart](../README.md#quickstart-with-docker) or [running without Docker](DEPLOYMENT.md#running-without-docker).

## Prerequisites

The [requirements](../README.md#requirements) plus one thing: **Docker**, which development needs and running the app does not. It is required for `test:integration` and `test:e2e`, and not for `test`, `lint`, `typecheck` or `build`.

## Scripts

Run from the repo root; Turborepo fans each one out to every package that defines it.

| Command | What it does |
|---|---|
| `pnpm dev` | Start Next.js (Turbopack) in dev mode |
| `pnpm build` | Production build of all packages |
| `pnpm lint` | Biome check: lint + import organization + format check |
| `pnpm format` | Biome: write formatting fixes |
| `pnpm typecheck` | `tsc --noEmit` per package |
| `pnpm test` | Unit suites — no database, no Docker |
| `pnpm test:coverage` | Unit suites with a v8 coverage report |
| `pnpm test:integration` | Testcontainers suites — needs Docker |
| `pnpm test:e2e` | End-to-end suites — needs Docker and a real `PROVIDER_API_KEY` |

## Test levels

Three levels, increasing in cost:

1. **Unit** (`*.test.ts`, colocated with source) — free and fast, no external dependencies. Includes `*.sdk.test.ts` files, which run the real `ToolLoopAgent` against a scripted `MockLanguageModelV4`; still no network or Docker. Also includes `*.test.tsx` component tests in `apps/web`, colocated with the component and rendered with Testing Library under jsdom. Run with `pnpm test`.
2. **Integration** (`*.integration.test.ts`, under each package's `tests/integration/`) — spins up a real Postgres via Testcontainers. Needs Docker; fails loudly (not a skip) if Docker is unavailable. Run with `pnpm test:integration`.
3. **E2E** (`*.e2e.test.ts` / `*.e2e.spec.ts`, under each package's `tests/e2e/`) — needs Docker **and** a real `PROVIDER_API_KEY` (env or `apps/web/.env.local`), and calls a real model through OpenRouter, which **consumes OpenRouter credits**. Run with `pnpm test:e2e`. Before the first run, install the Playwright browser once: `npx playwright install chromium`. The default model is `~deepseek/deepseek-v4-flash-latest` (the leading `~` is not a typo — it's OpenRouter's convention for an alias that always tracks the latest version of a model); set `E2E_MODEL` to point the suites at a different one.

CI (`.github/workflows/ci.yml`) runs levels 1 and 2 (`lint`, `typecheck`, `test`, `test:integration`, `build`) on every push to `main` and every pull request — it does not run e2e. A separate workflow (`.github/workflows/e2e.yml`) runs the e2e suite on manual `workflow_dispatch` only; its nightly cron trigger is commented out by default (see the workflow file for how to enable it). It needs the `PROVIDER_API_KEY` secret configured on the repository, and skips cleanly (no failure) when that secret isn't set — which is the case for forks that haven't configured it.

## Formatting and linting

Biome, not ESLint/Prettier. `pnpm lint` checks; `pnpm format` writes fixes. Config in `biome.json`: 2-space indent, Next + React linter domains, `organizeImports` on.

## Commit messages

Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `build:`, etc.).

## Before opening a PR

`pnpm lint && pnpm typecheck && pnpm test && pnpm build`. Add or update tests for whatever you change. Read [CONTRIBUTING.md](../CONTRIBUTING.md) first for what to expect from the review side.
