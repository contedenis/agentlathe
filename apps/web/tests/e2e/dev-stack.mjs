import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { APP_PORT } from "./port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(here, ".state.json");

function requireOpenRouterKey() {
  if (process.env.PROVIDER_API_KEY) return process.env.PROVIDER_API_KEY;
  const envFile = join(here, "../../.env.local");
  if (existsSync(envFile)) {
    const match = readFileSync(envFile, "utf8").match(
      /^PROVIDER_API_KEY=(.+)$/m,
    );
    if (match) return match[1].trim().replace(/^"|"$/g, "");
  }
  throw new Error(
    "PROVIDER_API_KEY is required: export it or set it in apps/web/.env.local",
  );
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function alreadyRunning(url) {
  try {
    const res = await fetch(url);
    return res.status < 500;
  } catch {
    return false;
  }
}

if (await alreadyRunning(`http://127.0.0.1:${APP_PORT}/`)) {
  throw new Error(
    `something is already answering on :${APP_PORT} — is another e2e stack (or e2e:stack) already running? Stop it first, or reuse it directly with 'cd apps/web && npx playwright test'.`,
  );
}

const apiKey = requireOpenRouterKey();
const container = await new PostgreSqlContainer("postgres:17-alpine").start();
const databaseUrl = container.getConnectionUri();

const pool = new pg.Pool({ connectionString: databaseUrl });
await migrate(drizzle(pool), {
  migrationsFolder: join(here, "../../../../packages/db/drizzle"),
});

const toolPort = await freePort();
const toolServer = spawn(
  process.execPath,
  [join(here, "tool-server.mjs"), String(toolPort)],
  { stdio: "inherit", detached: process.platform !== "win32" },
);

await pool.query(
  `insert into settings (id, track_dashboard_runs, track_v1_runs, track_mcp_runs)
   values ('singleton', true, true, true)
   on conflict (id) do update set track_dashboard_runs = true, track_v1_runs = true, track_mcp_runs = true`,
);
await pool.query(
  `insert into tools (name, description, endpoint, input_schema, needs_approval)
   select * from (values
     ('get_number', 'Returns the current number. Call it whenever the user asks for the number.', $1, '{"type":"object","properties":{}}'::jsonb, false),
     ('dangerous_cleanup', 'Deletes the whole workspace. Destructive.', $2, '{"type":"object","properties":{}}'::jsonb, true)
   ) as seed(name, description, endpoint, input_schema, needs_approval)
   where not exists (select 1 from tools where tools.name = seed.name)`,
  [
    `http://127.0.0.1:${toolPort}/number`,
    `http://127.0.0.1:${toolPort}/cleanup`,
  ],
);
await pool.end();

const app = spawn("pnpm", ["exec", "next", "dev", "-p", String(APP_PORT)], {
  cwd: join(here, "../.."),
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    PROVIDER_API_KEY: apiKey,
    // The proxy's Host allowlist defaults to :3000; this stack runs on another port.
    APP_URL: `http://localhost:${APP_PORT}`,
    SCHEDULER_ENABLED: "false",
  },
  stdio: "inherit",
  shell: true,
  detached: process.platform !== "win32",
});

writeFileSync(
  STATE_FILE,
  JSON.stringify({
    persistent: true,
    containerId: container.getId(),
    appPid: app.pid,
    toolServerPid: toolServer.pid,
    databaseUrl,
  }),
);

await waitFor(`http://127.0.0.1:${APP_PORT}/`, 150_000);
console.log(
  `\ne2e stack ready: app on :${APP_PORT}, tools on :${toolPort}, db ${databaseUrl}\nIterate with: cd apps/web && npx playwright test\nCtrl+C stops everything.\n`,
);

function shutdown() {
  for (const pid of [app.pid, toolServer.pid]) {
    if (!pid) continue;
    try {
      if (process.platform === "win32")
        execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
      else process.kill(-pid, "SIGKILL");
    } catch {}
  }
  execSync(`docker rm -f ${container.getId()}`, { stdio: "ignore" });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await new Promise(() => {});
