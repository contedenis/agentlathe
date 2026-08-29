import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

type Database = ReturnType<typeof drizzle<typeof schema>>;

declare global {
  var __agentlathePool: Pool | undefined;
}

let poolInstance: Pool | undefined;
let dbInstance: Database | undefined;

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set.");
  }
  const created = new Pool({ connectionString });
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
