import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { APP_PORT } from "./port.mjs";

const here = (path: string) => join(__dirname, path);
const STATE_FILE = here("./.state.json");

function requireOpenRouterKey(): string {
  if (process.env.PROVIDER_API_KEY) return process.env.PROVIDER_API_KEY;
  const envFile = here("../../.env.local");
  if (existsSync(envFile)) {
    const match = readFileSync(envFile, "utf8").match(
      /^PROVIDER_API_KEY=(.+)$/m,
    );
    if (match) return match[1].trim().replace(/^"|"$/g, "");
  }
  throw new Error(
    "PROVIDER_API_KEY is required for the e2e suite: export it or set it in apps/web/.env.local",
  );
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${url}: ${String(lastError)}`);
}

export default async function globalSetup() {
  try {
    const res = await fetch(`http://127.0.0.1:${APP_PORT}/`);
    if (res.status < 500) {
      console.log(
        `reusing the stack already running on :${APP_PORT} (started with e2e:stack)`,
      );
      return;
    }
  } catch {}

  const apiKey = requireOpenRouterKey();

  const container = await new PostgreSqlContainer("postgres:17-alpine").start();
  const databaseUrl = container.getConnectionUri();

  const pool = new Pool({ connectionString: databaseUrl });
  await migrate(drizzle(pool), {
    migrationsFolder: here("../../../../packages/db/drizzle"),
  });

  const toolPort = await freePort();
  const toolServer = spawn(
    process.execPath,
    [here("./tool-server.mjs"), String(toolPort)],
    {
      stdio: "ignore",
      detached: process.platform !== "win32",
    },
  );

  await pool.query(
    `insert into settings (id, track_dashboard_runs, track_v1_runs, track_mcp_runs)
     values ('singleton', true, true, true)
     on conflict (id) do update set track_dashboard_runs = true, track_v1_runs = true, track_mcp_runs = true`,
  );
  await pool.query(
    `insert into tools (name, description, endpoint, input_schema, needs_approval) values
     ('get_number', 'Returns the current number. Call it whenever the user asks for the number.', $1, '{"type":"object","properties":{}}', false),
     ('dangerous_cleanup', 'Deletes the whole workspace. Destructive.', $2, '{"type":"object","properties":{}}', true)`,
    [
      `http://127.0.0.1:${toolPort}/number`,
      `http://127.0.0.1:${toolPort}/cleanup`,
    ],
  );
  await pool.end();

  const app = spawn("pnpm", ["exec", "next", "dev", "-p", String(APP_PORT)], {
    cwd: here("../.."),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PROVIDER_API_KEY: apiKey,
      APP_URL: `http://localhost:${APP_PORT}`,
    },
    stdio: "ignore",
    shell: true,
    detached: process.platform !== "win32",
  });

  writeFileSync(
    STATE_FILE,
    JSON.stringify({
      containerId: container.getId(),
      appPid: app.pid,
      toolServerPid: toolServer.pid,
      databaseUrl,
    }),
  );

  await waitFor(`http://127.0.0.1:${APP_PORT}/`, 150_000);
}
