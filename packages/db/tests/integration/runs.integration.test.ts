import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_RUN_TTL_DAYS,
  DEFAULT_TRANSCRIPT_TTL_DAYS,
} from "../../src/constants";
import { agentSlug } from "../../src/naming";
import * as schema from "../../src/schema";

const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);
const DAY_MS = 24 * 60 * 60 * 1000;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

describe("recordAgentRun / deleteExpiredAgentRuns (requires Docker)", () => {
  beforeAll(async () => {
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

  async function makeAgent(name: string) {
    const [agent] = await db
      .insert(schema.agents)
      .values({ name, slug: agentSlug(name), model: "test/model" })
      .returning();
    return agent;
  }

  async function runsFor(agentId: string) {
    return db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.agentId, agentId));
  }

  it("records nothing while tracking is off (no settings row)", async () => {
    const { recordAgentRun } = await import("../../src/runs");
    const agent = await makeAgent("tracking off");

    const runId = await recordAgentRun({
      agentId: agent.id,
      source: "v1",
      durationMs: 10,
    });

    expect(runId).toBeNull();
    expect(await runsFor(agent.id)).toHaveLength(0);
  });

  it("returns the id of the recorded run and links its transcript", async () => {
    const { recordAgentRun, saveRunTranscript, setSettings } = await import(
      "../../src/runs"
    );
    const agent = await makeAgent("transcript agent");
    await setSettings({ trackV1Runs: true });

    const runId = await recordAgentRun({
      agentId: agent.id,
      source: "v1",
      threadId: "thread-7",
      durationMs: 12,
    });
    expect(runId).toEqual(expect.any(String));
    if (!runId) throw new Error("expected a run id");

    await saveRunTranscript(
      runId,
      [{ role: "user", content: "hi" }],
      [{ role: "assistant", content: "hello" }],
    );

    const [transcript] = await db
      .select()
      .from(schema.runTranscripts)
      .where(eq(schema.runTranscripts.runId, runId));
    expect(transcript.input).toEqual([{ role: "user", content: "hi" }]);
    expect(transcript.output).toEqual([
      { role: "assistant", content: "hello" },
    ]);

    const [run] = await runsFor(agent.id);
    expect(run.threadId).toBe("thread-7");
  });

  it("records only the sources that are enabled", async () => {
    const { recordAgentRun, setSettings } = await import("../../src/runs");
    const agent = await makeAgent("tracking per source");
    await setSettings({ trackV1Runs: true, trackMcpRuns: false });

    await recordAgentRun({
      agentId: agent.id,
      source: "v1",
      durationMs: 120,
      steps: 2,
      inputTokens: 30,
      outputTokens: 12,
    });
    await recordAgentRun({
      agentId: agent.id,
      source: "mcp",
      durationMs: 999,
    });

    const rows = await runsFor(agent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("v1");
    expect(rows[0].durationMs).toBe(120);
    expect(rows[0].inputTokens).toBe(30);
    expect(rows[0].status).toBe("ok");
  });

  it("records scheduled runs by default, with the schedule they came from", async () => {
    const { recordAgentRun, setSettings } = await import("../../src/runs");
    const agent = await makeAgent("scheduled runs");
    const [schedule] = await db
      .insert(schema.schedules)
      .values({
        agentId: agent.id,
        name: "Morning digest",
        frequency: "daily",
        timeOfDay: "09:00",
        timezone: "America/Argentina/Buenos_Aires",
        input: "Summarize yesterday.",
      })
      .returning();

    const runId = await recordAgentRun({
      agentId: agent.id,
      source: "schedule",
      scheduleId: schedule.id,
      durationMs: 40,
    });
    expect(runId).toEqual(expect.any(String));

    await setSettings({ trackScheduleRuns: false });
    expect(
      await recordAgentRun({
        agentId: agent.id,
        source: "schedule",
        scheduleId: schedule.id,
        durationMs: 40,
      }),
    ).toBeNull();
    await setSettings({ trackScheduleRuns: true });

    const rows = await runsFor(agent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: runId,
      source: "schedule",
      scheduleId: schedule.id,
    });
  });

  it("truncates long error messages instead of failing the insert", async () => {
    const { recordAgentRun, setSettings } = await import("../../src/runs");
    const agent = await makeAgent("long error");
    await setSettings({ trackMcpRuns: true });

    await recordAgentRun({
      agentId: agent.id,
      source: "mcp",
      durationMs: 5,
      status: "error",
      error: "x".repeat(2000),
    });

    const rows = await runsFor(agent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].error).toHaveLength(500);
    expect(rows[0].status).toBe("error");
  });

  it("defaults the ttl to 90 days and persists a new value", async () => {
    const { getSettings, setSettings } = await import("../../src/runs");

    const defaults = await getSettings();
    expect(defaults.agentRunTtlDays).toBe(DEFAULT_AGENT_RUN_TTL_DAYS);
    expect(defaults.transcriptTtlDays).toBe(DEFAULT_TRANSCRIPT_TTL_DAYS);

    await setSettings({ agentRunTtlDays: 30 });
    expect((await getSettings()).agentRunTtlDays).toBe(30);

    const after = await setSettings({ trackV1Runs: true });
    expect(after.agentRunTtlDays).toBe(30);

    await setSettings({ agentRunTtlDays: DEFAULT_AGENT_RUN_TTL_DAYS });
  });

  it("records which tools, skills and mcp calls a run made", async () => {
    const { recordAgentRun, setSettings } = await import("../../src/runs");
    const agent = await makeAgent("calls detail");
    await setSettings({ trackMcpRuns: true });

    await recordAgentRun({
      agentId: agent.id,
      source: "mcp",
      durationMs: 42,
      calls: [
        { kind: "tool", name: "Suma emoji", durationMs: 10 },
        { kind: "skill", name: "Tone guide" },
        { kind: "mcp", name: "github__list_issues", status: "error" },
      ],
    });

    const [run] = await runsFor(agent.id);
    const calls = await db
      .select()
      .from(schema.agentRunCalls)
      .where(eq(schema.agentRunCalls.runId, run.id));

    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.kind).sort()).toEqual([
      "mcp",
      "skill",
      "tool",
    ]);
    expect(calls.find((call) => call.kind === "mcp")?.status).toBe("error");
  });

  it("deletes runs older than the ttl and keeps recent ones", async () => {
    const { deleteExpiredAgentRuns } = await import("../../src/runs");
    const agent = await makeAgent("ttl runs");

    const [old] = await db
      .insert(schema.agentRuns)
      .values({
        agentId: agent.id,
        source: "v1",
        durationMs: 1,
        createdAt: new Date(Date.now() - 100 * DAY_MS),
      })
      .returning();
    const [fresh] = await db
      .insert(schema.agentRuns)
      .values({ agentId: agent.id, source: "v1", durationMs: 1 })
      .returning();

    await deleteExpiredAgentRuns(90);

    const ids = (await runsFor(agent.id)).map((row) => row.id);
    expect(ids).not.toContain(old.id);
    expect(ids).toContain(fresh.id);
  });

  it("deletes transcripts older than the ttl and keeps recent ones", async () => {
    const { deleteExpiredTranscripts } = await import("../../src/runs");
    const agent = await makeAgent("ttl transcripts");

    // Both runs are fresh: transcripts expire on their own created_at, not the run's.
    const [oldRun] = await db
      .insert(schema.agentRuns)
      .values({ agentId: agent.id, source: "v1", durationMs: 1 })
      .returning();
    const [freshRun] = await db
      .insert(schema.agentRuns)
      .values({ agentId: agent.id, source: "v1", durationMs: 1 })
      .returning();

    await db.insert(schema.runTranscripts).values([
      {
        runId: oldRun.id,
        input: [{ role: "user", content: "old" }],
        output: [],
        createdAt: new Date(Date.now() - 20 * DAY_MS),
      },
      {
        runId: freshRun.id,
        input: [{ role: "user", content: "fresh" }],
        output: [],
      },
    ]);

    await deleteExpiredTranscripts(DEFAULT_TRANSCRIPT_TTL_DAYS);

    const runIds = (await runsFor(agent.id)).map((row) => row.id);
    expect(runIds).toEqual(expect.arrayContaining([oldRun.id, freshRun.id]));

    const transcripts = await db.select().from(schema.runTranscripts);
    const transcriptIds = transcripts.map((row) => row.runId);
    expect(transcriptIds).not.toContain(oldRun.id);
    expect(transcriptIds).toContain(freshRun.id);
  });

  it("ttl=0 never expires a transcript", async () => {
    const { deleteExpiredTranscripts } = await import("../../src/runs");
    const agent = await makeAgent("ttl zero transcripts");

    const [run] = await db
      .insert(schema.agentRuns)
      .values({ agentId: agent.id, source: "mcp", durationMs: 1 })
      .returning();
    await db.insert(schema.runTranscripts).values({
      runId: run.id,
      input: [{ role: "user", content: "kept" }],
      output: [],
      createdAt: new Date(Date.now() - 500 * DAY_MS),
    });

    await deleteExpiredTranscripts(0);

    const transcripts = await db.select().from(schema.runTranscripts);
    const transcriptIds = transcripts.map((row) => row.runId);
    expect(transcriptIds).toContain(run.id);
  });

  it("ttl=0 never expires anything", async () => {
    const { deleteExpiredAgentRuns } = await import("../../src/runs");
    const agent = await makeAgent("ttl zero runs");

    const [old] = await db
      .insert(schema.agentRuns)
      .values({
        agentId: agent.id,
        source: "mcp",
        durationMs: 1,
        createdAt: new Date(Date.now() - 500 * DAY_MS),
      })
      .returning();

    await deleteExpiredAgentRuns(0);

    const ids = (await runsFor(agent.id)).map((row) => row.id);
    expect(ids).toContain(old.id);
  });
});
