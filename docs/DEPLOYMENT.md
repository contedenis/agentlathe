# Deployment

Running agentlathe outside the Docker quickstart, and what to get right before it serves anything real. For the tradeoffs behind the security posture described here, see [SECURITY.md](../SECURITY.md).

## Running without Docker

You supply the Postgres. **Give agentlathe a database of its own** — it cannot share one. The migrations create 13 tables in `public`, and five of the names are generic enough to collide with something you already have: `agents`, `tools`, `skills`, `settings`, `mcp_servers`. Pointed at a database that already uses one of those, the migration aborts on the first collision and prints the `CREATE TABLE` it could not run, without saying that the name was already taken.

Its own schema is not a way around this: a `DATABASE_URL` carrying `?options=-c%20search_path%3D...` does set the search path, but the generated foreign keys are qualified as `"public"."agents"`, so the run dies on the first constraint instead.

Both failures are safe — migrations run in a transaction, so a failed one rolls back completely and leaves your existing tables untouched. Point `DATABASE_URL` at a database of its own and run it again.

Two things to know when that database is a managed one (Neon, Supabase, RDS and friends):

- **TLS**: append `?sslmode=require` to `DATABASE_URL` — the `pg` driver honors it, and nothing else in the app needs configuring. Without it, most managed providers refuse the connection.
- **Role privileges**: `drizzle-kit migrate` records its journal in a `drizzle` schema that it creates on first run, so the role needs `CREATE` on the *database*, not just on `public`. A role that owns the database is enough; a locked-down role that can only write to `public` fails on the journal, not on your tables. No extensions are required — the schema uses `gen_random_uuid()`, which is core Postgres since 13.

Migrations are run against `DATABASE_URL` from the shell; the Next.js dev server reads its own env from `apps/web/.env.local`. The commands below assume bash/zsh (inline env vars, a `cat <<'EOF'` heredoc) — on Windows, run them from Git Bash or WSL, or create `apps/web/.env.local` by hand with the same contents.

```bash
pnpm install

# 0. create the database (name assumed by the examples below: agentplatform)
createdb agentplatform

# 1. migrate (DATABASE_URL from the environment) — this connects to an
#    existing database; it does not create one
DATABASE_URL=postgres://postgres:postgres@localhost:5432/agentplatform \
  pnpm --filter @agentlathe/db migrate

# 2. optional seed
DATABASE_URL=postgres://postgres:postgres@localhost:5432/agentplatform \
  pnpm --filter @agentlathe/db seed

# 3. env for the dev server
cat > apps/web/.env.local <<'EOF'
DATABASE_URL=postgres://postgres:postgres@localhost:5432/agentplatform
PROVIDER_API_KEY=sk-or-...
EOF

# 4. run
pnpm dev
```

`apps/web/.env.local` is gitignored and is also where the e2e suite looks for `PROVIDER_API_KEY` — and where `AGENTLATHE_SECRET_*` variables (MCP auth references, see [docs/USAGE.md](USAGE.md#mcp-servers)) go when running without compose.

Note that `pnpm dev` does **not** bind to localhost the way the compose stack does — Next's dev server listens on all interfaces unless you pass a hostname (`next dev -H 127.0.0.1`).

## Production deployment

The [`Dockerfile`](../Dockerfile) is a multi-stage build with two consumable targets:

- **`runner`** — the runtime image. Next.js standalone output only: no pnpm, no workspace source, no devDependencies. This is what serves traffic.
- **`migrator`** — the full builder stage, kept because `pnpm --filter @agentlathe/db migrate` (which runs `drizzle-kit migrate`) needs `drizzle-kit` and the `packages/db/drizzle` folder, neither of which ships in the standalone output. Run it once per deploy, before the app starts.

[`docker-compose.yml`](../docker-compose.yml) is a working reference for that wiring — health check on postgres, `service_completed_successfully` on the migrator, `restart: unless-stopped` on the long-lived services. Adapt it rather than starting from scratch.

**Health endpoint.** `GET /api/health` does a `select 1` against the database and returns `200 {"status":"ok"}` or `503 {"status":"error"}`. Use it as your orchestrator's liveness/readiness probe and as the upstream check in your proxy; the compose stack already uses it as the app container's health check.

**Put a reverse proxy with authentication in front of it. This is not optional.** agentlathe has no auth of its own. Anyone who reaches the dashboard can read every transcript you recorded, edit every agent, and call every tool those agents can reach. Terminate TLS and authenticate at the proxy (nginx/Caddy with OAuth2 or basic auth, an authenticating load balancer, a VPN), and keep the app itself bound to loopback or a private network.

**Back up the `postgres_data` volume.** It holds everything: agents, tool definitions, MCP credentials **in plaintext** (except headers stored as `AGENTLATHE_SECRET_*` env references, which carry only the variable name — see [SECURITY.md](../SECURITY.md#secrets-are-stored-in-plaintext)), runs, and transcripts **in plaintext**. A database dump is therefore a dump of every secret and every recorded conversation — treat the backups with the same care as the database. See [SECURITY.md](../SECURITY.md).

**This is not a Vercel deployment.** It needs a persistent Postgres it owns (not just any connection string — the TTL sweeps, the run recorder and the migration story assume it) and a long-lived process: streaming completions, MCP clients held open for the duration of a run, MCP approval elicitations that block on a human, run evaluations that finish in the background after the response has gone out, and the [scheduler](#the-scheduler). A container platform (Docker Compose, Fly, Railway, a VM, Kubernetes) fits; a serverless function does not.

## The scheduler

Every app process runs a scheduler loop alongside the server: every 30 seconds it starts the [schedules](USAGE.md#schedules) that are due, and every ten minutes or so it sweeps expired runs and transcripts. There is no separate worker to deploy.

- **It needs a long-lived process.** Schedules only fire while an app process is up. A schedule that came due while none was running is skipped, not caught up.
- **Several replicas are fine.** Due schedules are claimed in Postgres, so two processes never start the same occurrence. To keep the scheduler out of some replicas — a web-only replica, a staging copy pointed at production data — set `SCHEDULER_ENABLED=false` on them. The Schedules page warns when no process has ticked in the last 90 seconds.
- **Give it time to stop.** On `SIGTERM` the app stops claiming, waits up to 20 seconds for scheduled runs in progress, then aborts the rest and marks them interrupted. The runner image sets `NEXT_MANUAL_SIG_HANDLE=true` so that Next.js does not exit before that, and the compose stack sets `stop_grace_period: 30s` (Docker's default is 10 seconds before `SIGKILL`). Under another orchestrator, allow at least 30 seconds. While it drains, the app still serves HTTP, and requests in flight when it exits are cut.
- **Without Docker,** run `next start` or the standalone `server.js` with `NEXT_MANUAL_SIG_HANDLE=true` in the environment (not in a `.env` file, which is read too late) to get the same drain. Without it, Next.js exits at once and runs in progress end up marked interrupted three minutes later.

In development `pnpm dev` runs the scheduler too, against whatever database `apps/web/.env.local` points at; set `SCHEDULER_ENABLED=false` there to keep it quiet. Editing the scheduler's code needs a restart of the dev server: hot reload does not restart the loop. The browser E2E suite starts its server with the scheduler off.

## Binding and CSRF

agentlathe is **single-tenant and has no authentication or authorization layer**. This is a deliberate scope decision, not an oversight. `docker-compose.yml` binds the app to `127.0.0.1` only (`127.0.0.1:3000:3000`), so it is not reachable from outside the host by default. Running via `pnpm dev` does **not** have this restriction — Next's dev server listens on all interfaces unless you pass a hostname yourself, e.g. `next dev -H 127.0.0.1`.

**If you expose this beyond localhost, you are responsible for putting your own reverse proxy and/or authentication in front of it.** Do not bind agentlathe directly to a public interface without one.

Mutating requests do go through a CSRF check (`apps/web/proxy.ts`): browser-initiated cross-site requests are rejected via `Sec-Fetch-Site`/`Origin`, and the `Host` header must be on the allowlist (`localhost:3000`, `127.0.0.1:3000`, or the host of `APP_URL`). Set `APP_URL` when serving on any other host **or port** — including the easy-to-miss case where port 3000 is busy and `next dev` silently moves to 3001: the dashboard loads fine, and every POST is rejected with 403 until `APP_URL=http://localhost:3001` is set. Non-browser clients (curl, OpenAI SDKs, MCP clients) are unaffected.
