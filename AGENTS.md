# AGENTS.md — agentlathe

Working guide for coding agents and anyone about to change this codebase. It records the invariants that are cheap to break by accident and expensive to notice later.

**Sources of truth, in this order:** the DB schema (`packages/db/src/schema.ts`), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the pieces fit, and this file for the rules that are not visible in either. All three are maintained; if you change behavior that one of them describes, update it in the same commit.

**[`CHANGELOG.md`](CHANGELOG.md)** is written for people running an instance, not for developers: a change they can see gets an entry under `## [Unreleased]` in the same commit, worded by its effect ("runs can be judged against criteria", not "add evaluation-panel"), and anything an upgrade requires of them — a migration, a new or renamed env var, a changed default, data leaving the instance — goes under **Upgrading**. Releasing renames `Unreleased` to the version and date, opens a new empty `## [Unreleased]` above it, updates the compare links at the bottom of the file, bumps `version` in the root and `apps/web` `package.json`, and tags the commit `vX.Y.Z`.

## What this is

A self-hosted workshop for AI agents: define them in a DB, expose each as an OpenAI-compatible model, and **review what they actually did**. See [`README.md`](README.md) for the product framing and [`docs/USAGE.md`](docs/USAGE.md) for what each feature does.

Deliberately absent, in roadmap order: **replay** (re-running recorded inputs against the current agent and judging them; evaluators today only judge runs that already happened), **memory, scheduling** — plus, orthogonal to that chain, **native provider SDKs** (any OpenAI-compatible endpoint already connects via `PROVIDER_BASE_URL`; absent are native Anthropic support and `/models` metadata fallbacks). Also absent: auth (single-tenant by design). Do not add any of them uninvited.

## Commands

Package manager is **pnpm** (see `pnpm-workspace.yaml`) — do not use npm/yarn.

```bash
pnpm dev               # turbo run dev (Next.js Turbopack)
pnpm build             # turbo run build
pnpm lint              # turbo run biome:check (lint + import-organize + format check)
pnpm format            # turbo run biome:format
pnpm typecheck         # turbo run typecheck (tsc --noEmit per package)
pnpm test              # unit suites: no database, no Docker, always runnable
pnpm test:coverage     # the unit suites with a v8 report, scoped to the pure modules they own
pnpm test:integration  # Testcontainers suites: requires Docker, fails loudly without it
pnpm test:e2e          # requires Docker AND PROVIDER_API_KEY (env or apps/web/.env.local), fails loudly without either.
                       # Runs two suites: the runner recording E2E (vitest) and the web browser E2E (Playwright, needs
                       # `npx playwright install chromium` once; boots next dev on :3100 against a Testcontainers Postgres)
```

[`docs/DEVELOPING.md`](docs/DEVELOPING.md) is canonical for what these cost and when to reach for each.

Linting/formatting is **Biome** (`biome.json`), not ESLint/Prettier: 2-space indent, Next + React linter domains, `organizeImports` on. `packages/db/drizzle/meta/**` is excluded.

**Testing layout:** `*.test.ts` = unit, colocated with the source; `*.test.tsx` = component tests, colocated with the component (e.g. `apps/web/components/forms/mcp-server-form.test.tsx`), rendered with Testing Library under a jsdom environment, and part of the same ordinary unit suite (`pnpm test`) — no database, no Docker; `*.integration.test.ts` = needs Postgres, under `tests/integration/` per package — in apps/web these invoke Next route handlers directly as functions (`POST(new Request(...), { params: Promise.resolve({ id }) })`), no server boot; `*.e2e.test.ts` = needs Docker + a real provider key, under `tests/e2e/` (runner: vitest; web: Playwright `*.e2e.spec.ts` driving Chromium against a spawned `next dev`). The `*.sdk.test.ts` unit files run the REAL ToolLoopAgent against a scripted `MockLanguageModelV4` from `ai/test` — they pin the SDK↔collector contract (how denials and approvals actually surface) and run in the normal unit suite. Every package has `vitest.config.ts` (excludes integration); `packages/db`, `packages/runner` and `apps/web` add `vitest.integration.config.ts` (includes only those), and `packages/runner` also a `vitest.e2e.config.ts` for its e2e suite. `apps/web/vitest.config.ts` splits into two `test.projects`: `*.test.ts` runs under `environment: "node"` exactly as before, `*.test.tsx` runs under `environment: "jsdom"` with `apps/web/vitest.setup.tsx` (Testing Library's jest-dom matchers, plus stubs for `matchMedia`/`ResizeObserver`/`scrollIntoView`/pointer capture that jsdom lacks and Base UI needs). Integration suites do **not** skip when Docker is missing — they fail, on purpose: a silent skip once hid that the whole suite was broken.

Extract a pure module only when more than one call site (or a test that exercises real behavior) consumes it through its interface — `packages/db/src/naming.ts` is the model. A pure helper with a single consumer belongs next to that consumer; "it would be unit-testable" is not by itself a reason to extract. Modules whose pure helpers are unit-tested must still not import DB-touching code, or `pnpm test` stops running without a database.

## Architecture

**Turborepo + pnpm-workspaces monorepo**:

- `apps/web` — Next.js 16 App Router dashboard + API routes + shadcn/ui
- `packages/db` — Drizzle ORM + Postgres: schema, migrations, seed
- `packages/runner` — AI SDK 7 `ToolLoopAgent` builder and execution logic
- `packages/openai-server` — the OpenAI Chat Completions wire format, in both directions

Agents are **defined in the DB and materialized at runtime**, then exposed as **OpenAI-compatible models**. Multi-provider via **OpenRouter**, consumed through **`@ai-sdk/openai-compatible`** (`createOpenAICompatible`) — **not** `@openrouter/ai-sdk-provider`, which is pinned to AI SDK 6 and incompatible with `ai@7`. Do not "modernize" that dependency. The base URL is `PROVIDER_BASE_URL ?? https://openrouter.ai/api/v1` (`packages/runner/src/helpers.ts`), so an agent's `model` column is an OpenRouter slug or whatever slug the configured OpenAI-compatible endpoint serves.

**One explicit exception to "only OpenAI-compatible":** evaluators call a **Decisions API** (TypeSafe's Jev judge, which has no OpenAI-compatible equivalent). TypeSafe's own `/v1/systemone`, OpenRouter's `/api/alpha/decisions` and `/api/v1/systemone`, and other hosts share one request and response shape, so the endpoint is a URL, not a protocol choice. `apps/web/lib/judge.ts` is its **only** client and `judgeEndpoint()` its only resolver: `JUDGE_URL` (full endpoint) with `JUDGE_API_KEY`, or by default `../alpha/decisions` resolved against `PROVIDER_BASE_URL` with `PROVIDER_API_KEY` (or `JUDGE_API_KEY` when set). No host sniffing. Two rules: a `JUDGE_URL` without its own `JUDGE_API_KEY` refuses to call — the provider key is **never** sent to a different host — and the URL stays an env var, never a setting: the dashboard has no auth, and an editable URL would let anyone who reaches it redirect the judge key to their own server.

Full data model, transports and runner internals: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The invariants below are the ones you can break without any of it looking wrong.

### Data model invariants

- **The run is the durable unit.** `agent_runs` records one row per call from any source (`dashboard` | `v1` | `mcp`); `run_transcripts` (1:1, own table, own shorter TTL) holds the messages; `fix_drafts` (FK to run) holds the review notes; `run_evaluations` (FK to run and criterion) holds the judge's verdicts; `agent_runs.agent_version_id` points at the config it ran with. There is no conversation table — a thread is an optional `agent_runs.thread_id`, because `/v1` is stateless and cannot be threaded without the client saying so.
- Agent → (skills / tools / mcp / sub-agents) relations use **join tables with FK + `ON DELETE CASCADE`**, never `uuid[]` arrays.
- Deactivation (`is_active=false`) is the normal UI flow; hard-delete cascades and is reserved for deliberate cleanup.
- An agent composes its tools from three JOIN-resolved sources: HTTP (`agent_tools`), MCP (`agent_mcp_tools`, explicit selection by name — no wildcard), and sub-agents (`agent_sub_agents`, self-referential).
- The DB client (`packages/db/src/client.ts`) is **lazy**: the pool is built on first use, never at import. Importing the schema must not require `DATABASE_URL`. Moving the `Pool` construction to module scope breaks every unit test.
- **Migrations start from a single baseline** (`drizzle/0000_baseline.sql`), collapsed at the first public release because no published version predates it. Add schema changes with `pnpm db:generate` as usual. The one thing the generator cannot do is transform existing rows: making a column `NOT NULL`, adding a `UNIQUE`, or deriving a value all need a hand-written `UPDATE` **before** the constraint, in the same migration — otherwise the upgrade aborts on the first database that has data in it. Every integration suite migrates a clean container, so the baseline is exercised on every run; a data backfill is not, and is the one thing worth testing by hand.
- **Metrics reshaping is pure**: `apps/web/lib/metrics-assembly.ts` holds the in-memory joins (capability diffing, series/trend, parent reconciliation) and is unit-tested without Postgres; `lib/queries-metrics.ts` owns only the SQL that feeds it. Capabilities carry both `name` (derived, the join key) and `displayName` (what the user typed) — the UI shows `displayName`.

### Recording and stats

The mechanism is documented in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#metrics-recording). What you must not do:

- **Transports never call `recordAgentRun` / `saveRunTranscript` directly.** `createRunRecorder` (`packages/runner/src/recording.ts`) is the single writer, and it owns both gates: `settings.track_*_runs` decides whether the run row exists, `agents.record_traffic` decides whether the transcript is stored for v1/mcp. No run row means no transcript and nothing to annotate.
- **Never pass stats-collecting callbacks at call level.** `onToolExecutionEnd` / `onStepEnd` go on the `ToolLoopAgent` *constructor* only: constructor and call callbacks BOTH fire, which double-counts. The one legitimate call-level callback is `onToolExecutionStart` in `generateWithApprovals` (`generate-with-approvals.ts`), which reports progress and collects nothing — that is not a violation of this rule.
- **Automatic evaluation hangs off the recorder's `onTranscriptSaved`**, wired by `createRecorder` (`apps/web/lib/run-recorder.ts`), the only way transports build a recorder. Transports never call `evaluateRun`. It runs in the background, gated on `auto_evaluate`, and its errors are swallowed like recording's: the response never waits for or depends on the judge.
- **The collector already dedupes denials by tool-call id.** Do not reimplement it. Denials reach the recorder through three different paths depending on how the denial happened; all three are pinned by the `*.sdk.test.ts` suites against the real SDK.
- **`packages/runner/src/versions.ts` is the only owner of the agent snapshot and its hash.** The recorder resolves the version when it is *created* (the config the run started with), only for a tracked source, and swallows a failure to a null `agent_version_id`. A config field that changes behavior belongs in `agentConfigSnapshot`; identity, flags and timestamps do not. Stored snapshots are read back only through `readSnapshot` (`apps/web/lib/version-diff.ts`), and versions written before a shape change stay in the database for as long as their agent exists: a new field must be optional to the reader, or old versions stop rendering on the metrics and run pages.
- **The snapshot never contains `auth_config` or any other secret.** `agent_versions` is stored without a TTL (only the hash reaches the UI), so `maskUrl` keeps only the scheme and host of every endpoint and server URL readable and replaces the rest (userinfo, path, query, fragment) with one short digest of the whole URL. Tests pin both.

### Evaluators

- **Verdicts derive from probabilities, applicability first** (`deriveStatus`, `apps/web/lib/evaluation-verdict.ts`): when a criterion has `applies_when`, `p_applies < fail_below` → `not_applicable` and `p_applies < pass_above` → `needs_review`; only then `p_pass < fail_below` → `fail`, `p_pass >= pass_above` → `pass`, anything between → `needs_review`. A run that ends on a pending approval is `skipped`/`awaiting_approval` without calling the judge, and a `max_tokens_exceeded` rejection is `skipped`/`too_long`, never an error — there is no token estimation.
- Re-evaluating upserts on `(run_id, criterion_id)`: a real judgement replaces the row, and `reviewed_verdict` survives it when the judged question text is unchanged (a human review belongs to the question it answered) and is cleared only when the question was edited; an `error`/`skipped` outcome never overwrites a judged row. The judge sees earlier turns as user-only context under a header; keep the header strings in `evaluation-input.ts`.

### Runner rules (AI SDK 7 — verify against the code, never invent APIs)

- Use `ToolLoopAgent` (`{ model, instructions, tools, stopWhen, toolApproval, prepareStep }`) with `.generate()`/`.stream()`, **not raw `streamText`**. Step limit via `stopWhen: stepCountIs(N)`.
- **Sub-agents**: a tool's `execute` calls `childAgent.generate()` and returns `.text` (never a `Response`). The SDK prevents no recursion — the runner does it, in `packages/runner/src/context.ts`: `callStack` (a `Set` **copied per branch**), `depth` against `MAX_DEPTH` (5), and `subAgentBudget` against `MAX_SUB_AGENT_CALLS` (20). The budget object is **shared by reference across the whole run tree** — copying it per branch, the way `callStack` is copied, silently multiplies the limit.
- **Compaction**: `prepareStep` + `pruneMessages` (removes, does not summarize, and preserves tool-call/tool-result pairing). Never inject a floating `system` message mid-array.
- **Tool names reaching the provider must match `[a-zA-Z0-9_-]`** — providers reject anything else and the whole call fails. Names are free text in the UI; every derived name comes from `packages/db/src/naming.ts` (`slug`, `httpToolName`, `mcpToolName`, `subAgentToolName`, `agentAskToolName`) — never re-derive one inline, in TS or in SQL. Note that `mcpToolName` slugs only the server prefix: the remote tool name is passed through untouched, so a remote tool with an exotic name is a provider-side failure you cannot fix by renaming locally.
- **Agent slugs**: `agentSlug()` derives one from a name; a user-supplied slug must match `AGENT_SLUG_PATTERN` (`/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/`) and `AGENT_SLUG_MAX_LENGTH` (64). The slug is the **public identifier**: it is the model id in `/v1` and the path segment of the MCP endpoint. Changing an agent's slug breaks every external client pointing at it.
- **`load_skill` is a reserved tool name.** If an agent has a tool that resolves to it, `assembleRuntime` renames the user's tool via `addTool` and carries its kind **and its approval gate** to the new name. Any code that renames a tool must carry both, or a gated tool silently loses its gate.
- **MCP auth env references**: an auth header value starting with `AGENTLATHE_SECRET_` is an env var *name*, resolved whole-value in `buildAuth` (`packages/runner/src/helpers.ts`) at connection time and nowhere else; a missing or empty var throws before any request goes out. The app must NEVER read `AGENTLATHE_SECRET_*` for its own configuration — that prefix is the allowlist keeping the no-auth dashboard from exfiltrating app secrets, and any app config landing in it silently breaks the guarantee.
- **No helper exists to *serve* OpenAI-compatible** (`createOpenAICompatible` is for *consuming*). The `/v1` SSE serialization, including `tool_calls` deltas, is hand-written in `packages/openai-server/src/index.ts`, re-exported through `packages/runner`.
- Tool `inputSchema`: use `jsonSchema(input_schema)`, never hand-convert JSON Schema → Zod.
- `streamAgentForUI` composes `createAgentUIStream` + `createUIMessageStream` on purpose: the run id only exists once the turn ended, with the stream in flight, so it goes out as a `data-run` part. It also passes `generateMessageId` so the message ids in the transcript match the ones the client saw — otherwise annotations cannot anchor.
- **The SDK calls `onError` twice per streaming failure** — the real error first, then masked text. `streamAgentForUI` keeps the first with `streamError ??= error`. A plain assignment records "An error occurred." on every failed run and destroys half the value of the review loop.
- **A tool that throws is not a lost cause and not a broken loop.** The SDK catches it, feeds the model a tool-error whose text is `error.toString()`, and keeps looping. Two consequences: throw a real `Error` with the payload in `.message` (anything not `instanceof Error` reaches the model as `JSON.stringify`, often `"{}"`), and do **not** reach for `toModelOutput` to shape an error — it is bypassed for tool errors, and `ai@7` has no per-tool `onError`.

### Resilience & concurrency (non-negotiable)

- Independent awaits → `Promise.all`, never serial. An `await` inside a `for`/`map` over a list is a red flag.
- MCP connections (may fail individually) → **`Promise.allSettled`**: one dead connection must never abort the others. Always `client.close()` (try/finally). Normalize `conn.name` to a slug before using it as a tool-name prefix.
- MCP is a **soft dependency**: its absence must not take down the app. Recording likewise — `recordAgentRun` and `saveRunTranscript` swallow their errors, because observability must never break a request. Those try/catch blocks look like they are hiding failures; they are load-bearing.

### Transport / API split

- **Dashboard (Playground)**: `POST /api/agents/[id]/chat` → `streamAgentForUI` (UIMessageStream for `useChat`). `needs_approval` tools pause the loop and surface an approval banner. Records run + transcript, and returns the thread id in `x-thread-id`.
- **Public `/v1` (OpenAI-compatible)** is **stateless**: the client owns the full `messages` array. Accepts an optional `x-thread-id`. Headless `needs_approval` tools are **denied** with an explanatory tool-result, never left hanging.
- **MCP** (`/mcp/agents/[id]`): one tool per agent (`ask_{slug}`), with elicitation-based approval when the client supports it, headless auto-deny when it does not.
- **Agent lookup is centralised in `loadActiveAgent`** (`packages/runner/src/loaders.ts`) and every transport uses it: if the string is a uuid, look up by id; otherwise by **slug (preferred)**, falling back to name. Never compare an arbitrary name against a uuid column, and never query `agents` by hand in a transport.

### Closed decisions (do not re-litigate)

- **No auth**: single-tenant, bind to `127.0.0.1`, auth delegated to the deploy's reverse proxy.
- **No `WorkflowAgent`**: it is stream-only (no `generate()`, which sub-agents and `/v1` both need), requires the Workflow DevKit runtime and a durable backend, and its transport — writing `ModelCallStreamPart`s to a `writable`, plus a separate GET endpoint to resume — does not compose with `createAgentUIStream`. The durability it buys is not what this project is missing. Revisit if runs ever have to survive a restart.
- MCP: http transport only, explicit tool selection, no wildcard, no client pooling.
- **No redaction of transcripts.** A deliberate stance documented in [`SECURITY.md`](SECURITY.md), not an oversight to fix quietly.

## Next.js 16 specifics

- `params`/`searchParams` are async: `const { id } = await params;` with `{ params }: { params: Promise<{ id: string }> }`.
- Caching is opt-in via `"use cache"`. Turbopack is the default bundler. Requires **Node 22+** (`engines.node` is `>=22`).
- Path alias `@/*` maps to **`apps/web/`**, defined in `apps/web/tsconfig.json` — it only resolves inside `apps/web` (so `@/lib/csrf` is `apps/web/lib/csrf.ts`). There is no `tsconfig.json` at the repo root.
- The middleware is `apps/web/proxy.ts` (Next 16 renamed it from `middleware.ts`). It runs the CSRF check on every mutating request via `isTrustedRequest` (`apps/web/lib/csrf.ts`), whose host allowlist is `localhost:3000`, `127.0.0.1:3000` and the host of `APP_URL`. Serving the dev server on any other port without setting `APP_URL` makes every POST return 403 — and you will not find the cause by grepping for "middleware".
- Lazy cleanup of expired rows rides on `after()` from `next/server` via `scheduleRetentionSweep` (`apps/web/lib/retention.ts`), called explicitly from the pages that show run data — no cron, and never hidden inside a read function.
- After deleting or renaming files, a stale `.next` can keep serving the old module graph; if the dev server errors with "module factory is not available", delete `apps/web/.next`.
