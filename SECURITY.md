# Security notes

agentlathe is a **single-tenant MVP with no authentication layer** (see the ["Security model" section](README.md#security-model-there-is-no-auth) of the README). This file records known security tradeoffs and deferred work so they are not mistaken for oversights.

## Secrets are stored in plaintext

MCP server credentials live in the `mcp_servers.auth_config` jsonb column **in plaintext** (e.g. `{"headers": {"Authorization": "Bearer <token>"}}`). The same applies to any secret placed in a tool's config. There is no encryption at rest.

**The escape hatch — env var references:** an auth header value that starts with `AGENTLATHE_SECRET_` is stored as-is, because it is just an env var *name*, and is resolved from the app's environment at connection time. Secrets referenced this way never touch the database — dumps and backups carry only the variable name, and rotating one is an env edit plus a restart. The prefix is a deliberate allowlist: the app never reads `AGENTLATHE_SECRET_*` for its own configuration, so a dashboard user cannot use a reference to make the app leak its own secrets (`DATABASE_URL`, `PROVIDER_API_KEY`) to a server they control. Anyone with dashboard access *can* still exfiltrate any `AGENTLATHE_SECRET_*` variable by pointing a reference at their own server — the reverse proxy remains the boundary, as everywhere else. A missing or empty variable fails the connection before any request is sent.

**Is that acceptable?** For the current scope — single user, no auth layer, the app bound to `127.0.0.1` by the Docker Compose stack — plaintext is a reasonable, deliberate tradeoff. An attacker with database or host access already has everything; encrypting with a key that lives in the same `.env`/host adds little.

**But note the caveats:**

- ~~The secret is echoed back to the browser~~ — **resolved**: `auth_config` is write-only from the API's point of view. `GET /api/mcp-servers` and `GET /api/mcp-servers/[id]` (and the RSC queries backing the dashboard) project an explicit column list plus a `hasAuth: boolean` instead of selecting `*`, so the plaintext value never leaves the server. `POST`/`PATCH` still accept `authConfig` in the request body to set it, but their responses use the same safe projection. The edit form says the credentials are already set instead of showing them, and only sends a new value when the user types one.
- **Database dumps/backups** carry live credentials for literal header values; `AGENTLATHE_SECRET_*` references are the exception — the dump carries only the variable name.
- Secrets must **never be logged** — `auth_config` should be kept out of any log line or error payload.

**Revisit — move to encryption at rest (key from env/KMS) + redaction on read — before any of:**

1. Exposing the app beyond localhost (network reachable).
2. Multi-user / multi-tenant usage.
3. Adding the OAuth flow below (refresh tokens are long-lived, higher-value secrets than a scoped PAT).

## Transcripts are stored verbatim

When recording is on for an agent, `run_transcripts` stores the **actual messages** of each call — input and output — as they were sent. There is no redaction, masking or hashing of anything: not API keys a caller pastes into a prompt, not personal data, not the tool arguments and results in between.

**Is that acceptable?** For the intended use — your own agents, your own lab, bound to `127.0.0.1` — yes: a transcript you cannot read is a transcript you cannot review, and review is the point of the tool. That is why the defaults are conservative: the Playground records because it is you talking to your own agent, while API and MCP traffic records nothing until you switch it on **per agent** ("Record external traffic" in the agent's configuration).

**The caveats compound with the ones above:** database dumps carry the transcripts too, and anyone who can reach the dashboard can read every one of them — there is no auth to stop them.

Retention limits the exposure window rather than removing it: transcripts default to a 14-day TTL, shorter than the 90 days for run metadata, and are swept lazily. Deleting an agent or a run deletes its transcripts by cascade.

**Evaluating a run sends its transcript to a second party.** When one of an agent's runs is evaluated against its criteria, or previewed against a draft criterion, the run's transcript — serialized as text, tool inputs and outputs included (each capped at 2000 characters) — goes to TypeSafe, the provider behind the Jev judge — through OpenRouter's Decisions API by default, or through whatever host `JUDGE_URL` names (TypeSafe directly, or a gateway in between) — on top of whatever the agent's own model provider already saw. Nothing is sent for a run nobody evaluates or previews. `JUDGE_URL` is an env var and not a setting on purpose: an editable URL would let anyone who reaches the dashboard point the judge, and its key, at their own server. For the same reason a `JUDGE_URL` without its own `JUDGE_API_KEY` refuses to call instead of falling back to `PROVIDER_API_KEY`.

**Revisit — redaction on write, or per-agent encryption — before** switching recording on for an agent that serves other people's data, and check what your jurisdiction expects you to tell them first.

## MCP authentication: PAT today, OAuth is deferred

MCP servers currently authenticate with **static headers only** — you provide a token (e.g. a GitHub fine-grained PAT) in `auth_config.headers.Authorization`, and the runner forwards it on every request. There is **no interactive OAuth**: the runner is a headless HTTP client, so no sign-in popup appears. A `401 missing Authorization header` means the header was not configured.

The **OAuth 2.1 authorization-code flow is supported by the underlying library** (`@ai-sdk/mcp`) via the transport's `authProvider?: OAuthClientProvider` option — the SDK handles metadata discovery, Dynamic Client Registration, PKCE, token exchange and refresh. Wiring it up is deferred feature work, because the runner is headless and would require:

1. An `OAuthClientProvider` backed by Postgres (`tokens()` / `saveTokens()` per connection, `redirectToAuthorization()`).
2. A sign-in action on the MCP server page that opens the authorization URL (the sign-in popup).
3. A callback route (`/api/mcp-servers/[id]/oauth/callback`) to exchange the code and store the tokens.
4. Passing `authProvider` to the transport in the runner instead of static headers.

Open questions to resolve before committing to it: whether the target MCP server supports Dynamic Client Registration or requires a pre-registered app, and reachability of the redirect URI behind a proxy.

## HTTP and MCP endpoints are operator-supplied and untrusted

HTTP tool endpoints and MCP server URLs are provided by the operator and stored in the database. At run time, the agent runner POSTs tool inputs to these URLs; on demand, the MCP test button fetches them to verify configuration. There is no private-range blocking or URL allowlist: a configured endpoint can reach internal services (cloud metadata endpoints, Postgres port on the host, any service on the host network) and return the response body to the model.

**Is that acceptable?** For the current scope — single tenant, operator-controlled deployment, app bound to `127.0.0.1` — yes. The operator is already trusted with the agent's capability surface; any tool they configure will run, and any URL they point to is an explicit choice.

**The caveat:** Tool URLs are validated as syntactically valid URLs when written, but not filtered by destination. An operator can configure `http://127.0.0.1:5432/` (Postgres port) and the runner will attempt to POST to it.

**Revisit — add private-range blocking and / or an allowlist — before** expanding access beyond the operator (API keys issued to other users, multi-tenant usage).

## Memory trusts the caller's labels, and keeps what it is told

An agent's [memory](docs/USAGE.md#memory) is picked by two request headers, `x-subject-id` and `x-memory-key`. **Both are labels the caller chooses, not identities anyone checked.** A caller that sends another customer's subject id reads and writes that customer's memory; a caller that knows the custom key gets that memory. The key is a selector, not a secret: it is shown in the agent's configuration and in its versions.

What a memory holds goes into the instructions of later runs. It is framed there as data saved in earlier runs and not as instructions, but a model can still follow text it finds there, so **a memory fed by other people's traffic is a lasting prompt-injection channel**: something one caller gets an agent to save reaches every later run that loads the same memory, and with an agent memory or a custom key that means other callers' runs.

Memory has **no TTL and no redaction**. Entries and every past version stay until someone deletes their memory or its agent: deleting an entry hides it but keeps its history, which can be restored. The agent's tools refuse an entry that looks like a credential, and nothing else is checked: personal data a caller tells the agent can end up in memory. Compaction sends a memory's entries to the agent's own model, through the same provider.

**Forgetting a subject** deletes that subject's memory in every agent, with its history, plus the transcripts and fix drafts of the runs tagged with it, and the schedules acting for it. It finds the subject by its id, not by content: what its runs saved to an agent memory or a custom-key one, what other runs' transcripts say about it, and your database backups all keep it. It is a deletion tool for the data agentlathe filed under that subject, not redaction.

**Is that acceptable?** For your own agents and your own traffic, yes. The labels exist to separate memories, not to protect them from the people who can call the agent.

**Revisit before** giving memory to an agent that serves people you do not control: have your proxy set `x-subject-id` from the identity it authenticated, overwriting whatever the client sent (see [DEPLOYMENT.md](docs/DEPLOYMENT.md#production-deployment)), and turn on **Require approval** on that memory so nothing reaches later runs before a person reads it.

## Knowledge is sent out to be indexed, and read as data

Documents uploaded to a [knowledge collection](docs/USAGE.md#knowledge) leave the instance twice. **Their whole text goes to the embedding provider** when they are indexed — `PROVIDER_BASE_URL`, OpenRouter by default, with `PROVIDER_API_KEY` — and again every time `EMBEDDING_MODEL` changes. **Every search query goes there too**, and the model writes it from the conversation. **Parts of it then go to the agent's model**: the passages a search returns, or every document of a collection the agent reads whole, as part of each run, and from there into the run's transcript when it is recorded.

Inside the instance, the original file, its extracted text and its passages are stored in Postgres with **no TTL and no redaction**, until someone deletes the document or its collection. There are no permissions per collection: anyone who reaches the dashboard can read the text of every document and download the original, and any agent can be given any collection.

**A document is a prompt-injection channel.** Text in a document can be written to steer whoever reads it. Documents read whole are placed at the end of the instructions, framed as reference material — data, not instructions, never overriding the rules above them — and search results reach the model as the output of a tool, not as instructions. A model can still follow what it reads: the framing lowers the risk, it does not remove it.

**Is that acceptable?** For documents you chose and trust, yes: the instance is single-tenant, and the operator decides what each agent may read.

**Revisit before** uploading documents you did not write or check, attaching a collection to an agent that serves other people, or uploading anything your provider's data terms do not cover.

## Skill scripts run in a sandbox, and anyone at the dashboard can write one

A [skill](docs/USAGE.md#scripts) can carry JavaScript that an agent runs as a tool, and the skill form's **Test run** runs a script on demand (`POST /api/skills/test-run`). Since the dashboard has no auth, anyone who reaches it can run code on your server, inside the sandbox.

The sandbox is a QuickJS interpreter compiled to WebAssembly, in a worker thread that is started for one run and terminated after it. The script gets no host function at all: no network, no filesystem, no `process`, no environment, no `require`, no timers. What it can do is compute over the input it is given and return a value. It is stopped after two seconds; a script stuck inside one built-in call is stopped a second later, when the worker is killed. Its memory is capped at 64 MB by the WebAssembly instance and its input at 256 KB. What it returns is cut like a tool's result, and what it logs or throws is cut again by the app, because the script can reach the interpreter's own log limit.

**Is that acceptable?** For the current scope, yes: a script can do less than an HTTP tool, which already lets the same person make the server call any URL. What you are trusting is the isolation of QuickJS and WebAssembly, not a review of each script.

**The caveats:** scripts cost load, and the cap on it is per process. Every run can burn up to three seconds of one core and hold up to 64 MB of script memory, plus the worker thread that runs it. Four run at a time in each app process; sixteen more wait and the rest fail at once, so an agent that calls scripts in a loop, or the test endpoint called in a loop, can keep four cores busy and make everyone else's scripts wait or fail, but cannot take more than that. A vulnerability in QuickJS or in the WebAssembly runtime would be a way out of the sandbox; keep the app updated. And a script's source is stored in the agent's versions like a skill's text, with no TTL.

**Revisit — a lower cap, a cap per agent, or scripts off by a setting — if** the dashboard is reachable by people you would not let run code on the machine.

## The builder sends your catalog to its model

The [agent builder](docs/USAGE.md#the-agent-builder) is a model call like an agent's, to the same provider (`PROVIDER_BASE_URL`), with the model set as "Builder model". It is off until that is set, and it only runs when someone opens it and writes to it.

**It sends the catalog.** The ids, names and descriptions of every active HTTP tool (with its input schema and whether it needs approval), skill (and whether it runs a script), knowledge collection (and its size) and agent (and its slug) go to the model, with the ids and names of the MCP servers, and the names and descriptions of an MCP server's tools when it looks them up.

**On one agent, it also sends that agent and the runs it reads.** That is the agent's configuration, including its system prompt, memory purpose and custom memory key; the names and times of its schedules; its criteria with their results; and what it reads to improve the agent: the latest open notes on its runs, the verdicts, the run errors, and the transcript of any run it opens, with its tool calls and results.

**Outside a transcript, it never sends** an HTTP tool's endpoint, any credential or header, a skill's text or script, the prompt of an agent other than the one being worked on, or a document's text. A transcript it opens carries whatever that run's tools returned, cut at 2,000 characters each: a loaded skill's text, knowledge passages, memory entries, API responses.

**It reads and proposes; it never writes.** It has no tool that writes: a proposal reaches the database only when you save the form it was loaded into. It does connect to an MCP server when it lists that server's tools, with the stored credentials, exactly as **Test connection** does.

**Its conversations are not recorded.** There is no run and no transcript on the server, so no trace there of what was sent. The browser tab keeps the conversation, the transcripts it read included, until the tab is closed, and sends it again with every message. For as long as the tab stays open, that copy outlives the transcript's retention and a forgotten subject.

**What it reads is a prompt-injection channel.** Transcripts, notes and descriptions can carry text written to steer the builder, and whoever calls an agent whose traffic you record writes its transcripts. The builder is told to treat all of it as data and cannot save anything, but it can hand you a proposal that attaches a tool, removes an approval or rewrites the prompt. The card names what a proposal changes, including a model that changes and an MCP tool that loses its approval; a memory that stops requiring approval appears only as "memory settings". Read the card, and the form, before saving.

**Is that acceptable?** For your own instance, yes: it is one more path by which what you recorded leaves the instance, next to the judge and memory compaction, to the provider your agents already use.

**Revisit — a builder model on a separate endpoint, or a record of builder conversations — if** transcripts must not reach the provider your agents use, or you need to audit what was asked.

## Approval gate covers tools and skill scripts; sub-agents bypass it

The `needsApproval` flag exists for HTTP tools, for a skill's script and, per agent, for each selected MCP server tool: when set, the runner prompts for approval before executing the tool call (Playground banner, MCP elicitation) or denies it on the headless surfaces (`/v1`, sub-agents, scheduled runs). Sub-agent invocations themselves have no gate — delegation to a sub-agent always proceeds, and everything a sub-agent runs is headless, so its own gated tools are denied rather than executed.

**Is that acceptable?** For the current scope — single tenant, you choose which tools each agent gets — yes. The approval gate is a reminder, not a security boundary; the real control is the operator's choice of which tools to expose.

**Revisit — an approval surface for sub-agent delegation — if** delegation itself ever becomes a sensitive action in your setup.

## Retention sweep is lazy, and needs a page load or a scheduler

Run and transcript retention is enforced by a lazy sweep that queries for expired rows and deletes them according to their TTL (90 days for runs, 14 days for transcripts). It runs when one of the dashboard pages that shows run data (`/runs`, `/metrics`) loads, and about every ten minutes while the app's scheduler runs, which it does by default. Agent versions are not swept at all: each one keeps a snapshot of the agent's configuration (system prompt, skill bodies and scripts, tool schemas) for as long as the agent exists, with MCP auth left out and URLs reduced to scheme and host plus a digest. A secret typed into a system prompt or a skill therefore stays in `agent_versions` after the prompt is edited, and the dashboard shows it: the run page opens the configuration a run used, and the metrics page diffs versions. Knowledge documents are not swept either: they stay until someone deletes them or their collection.

**Is that acceptable?** Yes. A headless instance — one that only receives `/v1` or `/mcp` traffic and never loads the dashboard — is swept by its scheduler.

**The caveat:** With `SCHEDULER_ENABLED=false` on every process and no one loading the dashboard, the sweep never runs and expired data accumulates.

**Revisit — an independent retention job — if** you run the scheduler off on every replica for long periods.

## Reporting a vulnerability

If you discover a security vulnerability in agentlathe, please report it privately to avoid public disclosure of the issue before a fix is available.

**How to report:**
1. Do **not** open a public issue or discussion about the vulnerability.
2. Use GitHub's private vulnerability reporting feature:
   - Go to the repository's **Security** tab
   - Click **"Report a vulnerability"**
   - Provide details about the vulnerability and steps to reproduce

We will make a best-effort response. As a [single-maintainer project](README.md#project-status), response times may vary, but we take security reports seriously.

**Important note:** agentlathe is a **single-tenant application with no authentication layer by design** — read the ["Security model" section](README.md#security-model-there-is-no-auth) of the README before reporting. Reports claiming that "there is no login" or similar are not considered security vulnerabilities.
