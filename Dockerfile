# syntax=docker/dockerfile:1
#
# Multi-stage build. Compose picks the target with `build.target`:
#   - `runner`   the app: Next.js standalone output only, no pnpm or workspace source.
#   - `migrator` the `builder` stage as-is, since `drizzle-kit` and the migrations
#                folder do not ship in the standalone output.

FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@10.24.0 --activate
WORKDIR /app
# Self-hosted product: no anonymous telemetry pings out of the build/runtime.
ENV NEXT_TELEMETRY_DISABLED=1
ENV TURBO_TELEMETRY_DISABLED=1

# ---- deps: install workspace dependencies from the lockfile -----------------
FROM base AS deps
# python3/make/g++: cpu-features and ssh2 (via @testcontainers/postgresql) have native
# install scripts. The bindings are optional, but building them keeps the install clean.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/openai-server/package.json packages/openai-server/package.json
COPY packages/runner/package.json packages/runner/package.json
RUN pnpm install --frozen-lockfile

# ---- builder: full source, build the Next.js app -----------------------------
FROM deps AS builder
COPY . .
RUN pnpm --filter @agentlathe/web build

# ---- migrator: reuses the builder stage (full monorepo + drizzle-kit) -------
FROM builder AS migrator
CMD ["pnpm", "--filter", "@agentlathe/db", "migrate"]

# ---- runner: minimal runtime image, Next standalone output only --------------
FROM base AS runner
ENV NODE_ENV=production
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /app/apps/web/public ./apps/web/public

ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000
USER node
CMD ["node", "apps/web/server.js"]
