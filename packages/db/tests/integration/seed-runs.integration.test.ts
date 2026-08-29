import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../../src/schema";
import { AGENT_RUN_CALL_KINDS, AGENT_RUN_SOURCES } from "../../src/schema";

const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);
const DAY_MS = 24 * 60 * 60 * 1000;
const SEED_RUN_DAYS = 5;
const LEGAL_STATUSES = ["ok", "error"];

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

describe("seedRuns (requires Docker)", () => {
  beforeAll(async () => {
    process.env.SEED_RUN_DAYS = String(SEED_RUN_DAYS);
    process.env.SEED_RUNS_PER_DAY = "4";

    container = await new PostgreSqlContainer("postgres:16").start();
    process.env.DATABASE_URL = container.getConnectionUri();

    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await migrate(drizzle(pool), { migrationsFolder });
  }, 60000);

  afterAll(async () => {
    const { closePool } = await import("../../src/client");
    await closePool();
    await pool.end();
    await container.stop();
  });

  it("inserts runs and calls for the agents from the base seed, honoring FKs and the legal enums", async () => {
    const { seed } = await import("../../src/seed");
    await seed();

    const activeAgents = await db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(eq(schema.agents.isActive, true));
    expect(activeAgents.length).toBeGreaterThan(0);
    const activeAgentIds = new Set(activeAgents.map((row) => row.id));

    const { seedRuns } = await import("../../src/seed-runs");
    await seedRuns();

    const runs = await db.select().from(schema.agentRuns);
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(activeAgentIds.has(run.agentId)).toBe(true);
      expect(AGENT_RUN_SOURCES).toContain(run.source);
      expect(LEGAL_STATUSES).toContain(run.status);
      expect(run.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(run.createdAt.getTime()).toBeGreaterThanOrEqual(
        Date.now() - (SEED_RUN_DAYS + 1) * DAY_MS,
      );
    }

    const runIds = new Set(runs.map((run) => run.id));
    const calls = await db
      .select()
      .from(schema.agentRunCalls)
      .where(inArray(schema.agentRunCalls.runId, [...runIds]));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(runIds.has(call.runId)).toBe(true);
      expect(AGENT_RUN_CALL_KINDS).toContain(call.kind);
    }
  });
});
