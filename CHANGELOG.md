# Changelog

What changed in each version of agentlathe, written for the people running an instance. Each version lists what you need to do when you upgrade under **Upgrading**. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); before 1.0, a minor version may carry breaking changes, always listed under **Upgrading**.

## [Unreleased]

## [0.5.0] - 2026-11-25

### Added

- **Knowledge.** The new **Knowledge** section holds collections of documents agents can consult: PDF with a text layer, Markdown and plain text, up to 20 MB each. Each document is processed in the background — text extracted, split into passages and embedded with `EMBEDDING_MODEL` — and shows whether it is waiting, processing, ready or failed, and why; one that failed at the provider can be retried. The document page shows the extracted text, which is what agents read (the beginning of it, for a long document), and the original can be downloaded. Attach collections in the agent's new **Knowledge** card: by default the agent gets a `search_knowledge` tool and its instructions list the collections with their descriptions, so describe what each one holds. Each search returns the five closest passages with their collection, document and page. See [USAGE.md](docs/USAGE.md#knowledge).
- **Always read.** A collection attached as **Always read** goes whole into the agent's instructions, as reference material and not as instructions. The collections read whole share a quarter of the model's context: the agent form shows how much of it they take, and a collection that does not fit is searched instead for that run, which says so on the run and the agent page.
- The run page shows each knowledge search with its query and the passages it returned. An agent's version now includes the name, description and mode of each attached collection, not its documents: adding a document to a collection does not create a new version.

### Security

- The text of every document you upload is sent to the embedding provider (`PROVIDER_BASE_URL`, OpenRouter by default), and the passages an agent finds, or the documents it reads whole, reach the agent's model as part of its runs. Documents and their text have no TTL and no redaction, and anyone who reaches the dashboard can read and download them.
- A document can carry text written to steer the agent. Documents read whole are framed as data, not instructions, and search results arrive as tool output, but a model can still follow what it reads. See [SECURITY.md](SECURITY.md#knowledge-is-sent-out-to-be-indexed-and-read-as-data).

### Upgrading

- A migration adds the knowledge tables. The compose `migrator` applies it on `docker compose up --build`; without Docker, run `pnpm --filter @agentlathe/db migrate` before starting the app.
- The compose stack now runs Postgres from `pgvector/pgvector:0.8.6-pg16-trixie` instead of `postgres:16`: the same Postgres 16 on the same Debian release, so the existing `postgres_data` volume is reused. A volume first created by a `postgres:16` image from before mid-2025 (Debian bookworm) logs a collation version mismatch; run `REINDEX DATABASE agentplatform` and then `ALTER DATABASE agentplatform REFRESH COLLATION VERSION` once, and the same `ALTER DATABASE` for `postgres` and `template1`, which log it too. The image tag is pinned, so Postgres minor updates now arrive with agentlathe updates instead of on every pull.
- Without Docker, pgvector is optional. With the `vector` extension installed before you migrate (the `postgresql-16-pgvector` package, or your managed provider's switch), the migration creates it and search runs much faster; without it the migration logs a notice and goes on, and search uses plain SQL with the same results. Installing it later takes `CREATE EXTENSION vector` and a restart of the app. Once it exists, a `pg_dump` of the database only restores on a server that has pgvector.
- Documents are embedded with `EMBEDDING_MODEL` (default `openai/text-embedding-3-small`) through `PROVIDER_BASE_URL` and `PROVIDER_API_KEY`, so the provider must serve an OpenAI-compatible embeddings endpoint; OpenRouter does. Changing the model re-embeds every document, and until a document is re-embedded search does not find it. Every replica must use the same `EMBEDDING_MODEL`, or they keep re-embedding each other's documents.
- Uploaded documents are processed right after the upload; retries, documents interrupted by a restart and re-embedding after a model change wait for the next scheduler tick, or the next upload or retry. With `SCHEDULER_ENABLED=false` on every process, they wait for an upload or a retry.
- A reverse proxy in front of the app must accept request bodies of up to 25 MB for document uploads; nginx's `client_max_body_size` defaults to 1 MB, and larger uploads fail with 413.
- `search_knowledge` is now a tool name of its own. An HTTP or MCP tool of an agent with a searched collection that resolves to it is renamed for the model (`search_knowledge_2`), keeping its approval gate.

## [0.4.0] - 2026-11-07

### Added

- **Run subjects.** A run can say who it acted for: send `x-subject-id` on `/v1` or MCP, fill **Act as subject** in the Playground, or give a schedule a subject. The run page shows it and **Runs** filters by it. It is a label the caller picks, not an identity anyone checked.
- **Memory.** Give an agent one in its configuration: **Agent memory** (one for all its runs), **Agent memory per subject** (one per `x-subject-id`), or **Agent memory with a custom key**, used only when the request sends `x-memory-key` with the value set in the agent. Its entries are added to the end of the agent's instructions on every run, and the agent adds, edits and deletes them itself; changes are saved when the run ends and seen from the next run, or wait for your approval when the memory asks for it. When a memory passes 90% of its limit, the agent's model consolidates it to 60%, keeping pinned entries untouched; what it merged or dropped can be restored from each entry's history. The new **Memory** section edits, pins and restores entries and keeps every change; the run page shows the memory a run loaded and what it changed. A run without the subject or key its memory needs runs without it and says so on the run and the agent page, when that source is recorded. See [USAGE.md](docs/USAGE.md#memory).
- **Forget subject.** On a per-subject memory, or on **Runs** filtered by a subject, deletes that subject's memory in every agent, the transcripts and fix drafts of its runs, and the schedules that act for it. Its runs stay in metrics, without the subject.

### Security

- `x-subject-id` and `x-memory-key` are labels the caller picks: whoever sends one reads and writes that memory. Before giving memory to an agent that serves people you do not control, have your proxy set `x-subject-id` from the identity it authenticated, and turn on **Require approval** for that memory. What a memory holds reaches the instructions of later runs. Memory has no TTL and no redaction; see [SECURITY.md](SECURITY.md#memory-trusts-the-callers-labels-and-keeps-what-it-is-told).

### Upgrading

- `memory_add`, `memory_update` and `memory_delete` are now tool names of their own. An HTTP or MCP tool of an agent with memory that resolves to one of them is renamed for the model (`memory_add_2`), keeping its approval gate.
- A migration adds the run subject and the memory tables. The compose `migrator` applies it on `docker compose up --build`; without Docker, run `pnpm --filter @agentlathe/db migrate` before starting the app.
- Existing agents get no memory until you choose one in their configuration, and runs that send no `x-subject-id` are recorded as before.

## [0.3.0] - 2026-10-18

### Added

- **Schedules.** An agent can run on its own every hour, day, weekday, week or month, at a time in your time zone, with a message that can carry the date and when it last succeeded. Each time a schedule comes due it leaves an occurrence that says whether it ran, was skipped (missed or still running) or was blocked, and why; **Run now** starts one on demand. Five failed runs in a row pause the schedule. Managed in the new **Schedules** section, or through `/api/schedules`.
- Scheduled runs appear in **Runs** with the source **Scheduled**, with their transcript, and the agent and run pages link to their schedules. Approval-gated tools are denied in them, as on `/v1`.

### Changed

- Expired runs and transcripts are also deleted about every ten minutes while the app runs, not only when someone opens a page that shows runs.

### Security

- An instance that only serves `/v1` or MCP no longer keeps runs and transcripts past their retention, as long as its scheduler runs.
- Docker images built from a local checkout no longer contain your `.env` files. Until now `apps/web/.env.local`, with its `PROVIDER_API_KEY` and any `AGENTLATHE_SECRET_*` you kept there, was copied into the `migrator` image (the `app` image was not affected).

### Upgrading

- A migration adds the schedule tables. The compose `migrator` applies it on `docker compose up`; without Docker, run `pnpm --filter @agentlathe/db migrate` before starting the app.
- Scheduled runs are recorded by default, under a new **Schedules** switch in "What to record".
- Every app process now runs the scheduler, and several replicas can share one database. Set `SCHEDULER_ENABLED=false` on the processes that should not run it.
- On `SIGTERM` the app waits up to 20 seconds for scheduled runs in progress. The image sets `NEXT_MANUAL_SIG_HANDLE=true` for that, and the compose file gives the app `stop_grace_period: 30s`; under another orchestrator, allow at least 30 seconds before it kills the container. Without Docker, set `NEXT_MANUAL_SIG_HANDLE=true` in the environment of `next start` to get the same.
- If you built the images from a checkout that had `apps/web/.env.local`, rebuild them (`docker compose build`), delete the old `migrator` image and its build cache (`docker builder prune`), and rotate the `PROVIDER_API_KEY` and any `AGENTLATHE_SECRET_*` values that file held if the image ever left your machine.

## [0.2.0] - 2026-10-18

### Added

- **Evaluators.** Agents carry criteria: yes/no questions about each run, with optional descriptions of a pass and a fail, an "Only evaluate when" condition and their own thresholds. TypeSafe's Jev judges every new run with a stored transcript against them; verdicts the judge is unsure about land in a review queue, and your review overrides the judge. A fix draft turns into a criterion in one click, checked against the run it came from, and criteria can be copied between agents. Managed in the agent page's **Evaluation** tab.
- **Agent versions.** Every recorded run points at the configuration it ran with. The run page opens that configuration from its short hash.
- **Evaluation metrics.** Pass rate per criterion and agent version, with what changed between one version and the next, the pass rate over time, and how often your reviews agree with the judge. `/metrics` adds the overall pass rate and the runs awaiting review.
- **A judge endpoint of your own.** `JUDGE_URL` and `JUDGE_API_KEY` point the judge at TypeSafe's own API or any other host that serves Jev; the judge model is a setting under "What to record" in `/metrics`.

### Changed

- The run page shows its counts in one line and its review work in two tabs, **Evaluation** and **Fix drafts**, each labelled with what waits in it.
- The agent form groups "Record external traffic" and the new "Evaluate new runs automatically" under **Recording and evaluation**.

### Fixed

- A tool that fails, or input that does not match a tool's schema, no longer marks a Playground run as failed, hides the tool's error behind "An error occurred." or closes the agent's MCP connections mid-run.
- A Playground turn that continues after an approval is recorded with its real output instead of an empty one.
- `/v1` transcripts that carry an OpenAI tool-call history are read correctly, and a non-streaming `/v1` call can no longer be recorded twice.

### Security

- When an agent has active criteria, the transcripts of its evaluated runs are sent to the judge: TypeSafe, through OpenRouter or the host `JUDGE_URL` names. Agents without criteria send nothing.
- Agent versions keep a snapshot of each configuration (system prompt, skills, tool schemas) for as long as the agent exists, without MCP auth and with URLs reduced to scheme and host. A secret typed into a prompt stays in that history after you edit it. See [SECURITY.md](SECURITY.md).

### Upgrading

- Two migrations add the version and evaluation tables. The compose `migrator` applies them on `docker compose up`; without Docker, run `pnpm --filter @agentlathe/db migrate` before starting the app.
- Automatic evaluation is on for every agent, existing ones included, but does nothing until an agent has criteria.
- The judge uses OpenRouter's Decisions API with `PROVIDER_API_KEY` by default. If `PROVIDER_BASE_URL` points at another provider, evaluations fail until you set `JUDGE_URL` and `JUDGE_API_KEY` (see `.env.example`).

## [0.1.0] - 2026-09-14

First public release: agents defined in Postgres and exposed through an in-app Playground, an OpenAI-compatible `/v1` and one MCP endpoint per agent, with HTTP tools, MCP servers, skills, sub-agents and approval gates. Every call becomes a run you can read and annotate with fix drafts, and `/metrics` covers runs, latency, tokens and cost.

[Unreleased]: https://github.com/contedenis/agentlathe/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/contedenis/agentlathe/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/contedenis/agentlathe/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/contedenis/agentlathe/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/contedenis/agentlathe/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/contedenis/agentlathe/releases/tag/v0.1.0
