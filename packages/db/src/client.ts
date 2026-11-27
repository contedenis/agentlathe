import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

type Database = ReturnType<typeof drizzle<typeof schema>>;

declare global {
  var __agentlathePool: Pool | undefined;
}

let poolInstance: Pool | undefined;
let dbInstance: Database | undefined;

const DEFAULT_STATEMENT_TIMEOUT_SECONDS = 60;

// 0 leaves the server's own setting: pg sends no startup parameter for a falsy value.
function statementTimeoutMs(): number {
  const raw = process.env.DB_STATEMENT_TIMEOUT_SECONDS?.trim();
  const seconds = raw ? Number(raw) : Number.NaN;
  return Math.round(
    (Number.isFinite(seconds) && seconds >= 0
      ? seconds
      : DEFAULT_STATEMENT_TIMEOUT_SECONDS) * 1000,
  );
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set.");
  }
  const created = new Pool({
    connectionString,
    statement_timeout: statementTimeoutMs(),
  });
  created.on("error", (err) => {
    console.error("Postgres pool error:", err);
  });
  return created;
}

export function getPool(): Pool {
  poolInstance ??= globalThis.__agentlathePool ?? createPool();
  if (process.env.NODE_ENV !== "production") {
    globalThis.__agentlathePool = poolInstance;
  }
  return poolInstance;
}

function getDb(): Database {
  dbInstance ??= drizzle(getPool(), { schema });
  return dbInstance;
}

export async function closePool(): Promise<void> {
  const existing = poolInstance ?? globalThis.__agentlathePool;
  poolInstance = undefined;
  dbInstance = undefined;
  globalThis.__agentlathePool = undefined;
  await existing?.end();
}

export const db = new Proxy({} as Database, {
  get(_target, prop) {
    const value = Reflect.get(getDb(), prop);
    return typeof value === "function" ? value.bind(getDb()) : value;
  },
});
