# Security notes

agentlathe is a **single-tenant MVP with no authentication layer** (see the ["Security model" section](README.md#security-model-there-is-no-auth) of the README). This file records known security tradeoffs and deferred work so they are not mistaken for oversights.

## Secrets are stored in plaintext

MCP server credentials live in the `mcp_servers.auth_config` jsonb column **in plaintext** (e.g. `{"headers": {"Authorization": "Bearer <token>"}}`). The same applies to any secret placed in a tool's config. There is no encryption at rest.

**The escape hatch — env var references:** an auth header value that starts with `AGENTLATHE_SECRET_` is stored as-is, because it is just an env var *name*, and is resolved from the app's environment at connection time. Secrets referenced this way never touch the database — dumps and backups carry only the variable name, and rotating one is an env edit plus a restart. The prefix is a deliberate allowlist: the app never reads `AGENTLATHE_SECRET_*` for its own configuration, so a dashboard user cannot use a reference to make the app leak its own secrets (`DATABASE_URL`, `PROVIDER_API_KEY`) to a server they control. Anyone with dashboard access *can* still exfiltrate any `AGENTLATHE_SECRET_*` variable by pointing a reference at their own server — the reverse proxy remains the boundary, as everywhere else. A missing or empty variable fails the connection before any request is sent.

**Is that acceptable?** For the current scope — single user, no auth layer, the app bound to `127.0.0.1` by the Docker Compose stack — plaintext is a reasonable, deliberate tradeoff. An attacker with database or host access already has everything; encrypting with a key that lives in the same `.env`/host adds little.

**But note the caveats:**

- ~~The secret is echoed back to the browser~~ — **resolved**: `auth_config` is write-only from the API's point of view. `GET /api/mcp-servers` and `GET /api/mcp-servers/[id]` (and the RSC queries backing the dashboard) project an explicit column list plus a `hasAuth: boolean` instead of selecting `*`, so the plaintext value never leaves the server. `POST`/`PATCH` still accept `auth_config` in the request body to set it, but their responses use the same safe projection. The edit form shows a "configurado" placeholder instead of the token and only sends a new value when the user types one.
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
2. A "Connect" action in the dashboard that opens the authorization URL (the sign-in popup).
3. A callback route (`/api/mcp-servers/[id]/oauth/callback`) to exchange the code and store the tokens.
4. Passing `authProvider` to the transport in the runner instead of static headers.

Open questions to resolve before committing to it: whether the target MCP server supports Dynamic Client Registration or requires a pre-registered app, and reachability of the redirect URI behind a proxy.

## HTTP and MCP endpoints are operator-supplied and untrusted

HTTP tool endpoints and MCP server URLs are provided by the operator and stored in the database. At run time, the agent runner POSTs tool inputs to these URLs; on demand, the MCP test button fetches them to verify configuration. There is no private-range blocking or URL allowlist: a configured endpoint can reach internal services (cloud metadata endpoints, Postgres port on the host, any service on the host network) and return the response body to the model.

**Is that acceptable?** For the current scope — single tenant, operator-controlled deployment, app bound to `127.0.0.1` — yes. The operator is already trusted with the agent's capability surface; any tool they configure will run, and any URL they point to is an explicit choice.

**The caveat:** Tool URLs are validated as syntactically valid URLs when written, but not filtered by destination. An operator can configure `http://127.0.0.1:5432/` (Postgres port) and the runner will attempt to POST to it.

**Revisit — add private-range blocking and / or an allowlist — before** expanding access beyond the operator (API keys issued to other users, multi-tenant usage).

## Approval gate covers HTTP and MCP tools; sub-agents bypass it

The `needsApproval` flag exists for HTTP tools and, per agent, for each selected MCP server tool: when set, the runner prompts for approval before executing the tool call (Playground banner, MCP elicitation) or denies it on the headless surfaces (`/v1`, sub-agents). Sub-agent invocations themselves have no gate — delegation to a sub-agent always proceeds, and everything a sub-agent runs is headless, so its own gated tools are denied rather than executed.

**Is that acceptable?** For the current scope — single tenant, you choose which tools each agent gets — yes. The approval gate is a reminder, not a security boundary; the real control is the operator's choice of which tools to expose.

**Revisit — an approval surface for sub-agent delegation — if** delegation itself ever becomes a sensitive action in your setup.

## Retention sweep is lazy and tied to dashboard page loads

Run and transcript retention is enforced by a lazy sweep: when one of the dashboard pages that shows run data (`/runs`, `/metrics`) loads, a background job queries for expired rows and deletes them according to their TTL (90 days for runs, 14 days for transcripts). Agent versions are not swept at all: each one keeps a snapshot of the agent's configuration (system prompt, skill bodies, tool schemas) for as long as the agent exists, with MCP auth left out and URLs reduced to scheme and host plus a digest. A secret typed into a system prompt or a skill therefore stays in `agent_versions` after the prompt is edited, and the dashboard shows it: the run page opens the configuration a run used, and the metrics page diffs versions. In a headless instance — one that only receives `/v1` API or `/mcp` server traffic and never loads the dashboard — the sweep never runs, and expired data accumulates indefinitely.

**Is that acceptable?** For a development lab bound to `127.0.0.1` — yes. Headless instances are rare in the current scope, and lazy deletion is simpler than a scheduled cron job. The data is already single-tenant and not exposed.

**The caveat:** A headless operator (load balancer, external system calling `/v1` only) will never trigger the sweep.

**Revisit — add an explicit scheduled retention job (cron, or a Lambda / Cloud Task) — before** operating a headless instance at scale or retaining sensitive data for extended periods.

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
