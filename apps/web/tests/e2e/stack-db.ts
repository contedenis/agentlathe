import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

export function stackDatabaseUrl(): string {
  const state = JSON.parse(
    readFileSync(join(__dirname, ".state.json"), "utf8"),
  ) as { databaseUrl: string };
  return state.databaseUrl;
}

export function stackPool(): Pool {
  return new Pool({ connectionString: stackDatabaseUrl() });
}
