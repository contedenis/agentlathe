import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MetricsRange } from "../../lib/metrics-range";

const migrationsFolder = fileURLToPath(
  new URL("../../../../packages/db/drizzle", import.meta.url),
);

const CAFE_TOOL_NAME = "Búsqueda de café";
const MCP_SERVER_NAME = "GH Api!";
const MCP_TOOL_NAME = "list_issues";
const USED_SKILL_NAME = "Resumen de sesión";
const UNUSED_SKILL_NAME = "Skill sin uso";
const UNUSED_CHILD_AGENT_NAME = "Subagente Niño";
const ORPHAN_CALL_NAME = "orphan_tool_call";

let container: StartedPostgreSqlContainer;
let dbModule: typeof import("@agentlathe/db");
let queries: typeof import("../../lib/queries-metrics");
let range: MetricsRange;

let agentA: { id: string; name: string; slug: string };
let agentB: { id: string; name: string };
let agentD: { id: string; name: string };
let httpName: string;
let mcpName: string;
let subAgentNameForA: string;
let errorRunId: string;

describe("metrics queries (requires Docker)", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").start();
    process.env.DATABASE_URL = container.getConnectionUri();

    dbModule = await import("@agentlathe/db");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(drizzle(dbModule.getPool()), { migrationsFolder });

    queries = await import("../../lib/queries-metrics");
    const { parseMetricsRange } = await import("../../lib/metrics-range");
    range = parseMetricsRange({ days: "30" });

    httpName = dbModule.httpToolName(CAFE_TOOL_NAME);
    mcpName = dbModule.mcpToolName(MCP_SERVER_NAME, MCP_TOOL_NAME);

    const [a] = await dbModule.db
      .insert(dbModule.agents)
      .values({
        name: "Métricas Uno",
        slug: dbModule.agentSlug("Métricas Uno"),
        model: "test/model-a",
      })
      .returning();
    agentA = a;
    subAgentNameForA = dbModule.subAgentToolName(agentA.slug);

    const [b] = await dbModule.db
      .insert(dbModule.agents)
      .values({
        name: "Métricas Padre",
        slug: dbModule.agentSlug("Métricas Padre"),
        model: "test/model-b",
      })
      .returning();
    agentB = b;

    const [c] = await dbModule.db
      .insert(dbModule.agents)
      .values({
        name: UNUSED_CHILD_AGENT_NAME,
        slug: dbModule.agentSlug(UNUSED_CHILD_AGENT_NAME),
        model: "test/model-c",
      })
      .returning();

    const [d] = await dbModule.db
      .insert(dbModule.agents)
      .values({
        name: "Métricas Sin Runs",
        slug: dbModule.agentSlug("Métricas Sin Runs"),
        model: "test/model-d",
      })
      .returning();
    agentD = d;

    const [tool] = await dbModule.db
      .insert(dbModule.tools)
      .values({
        name: CAFE_TOOL_NAME,
        description: "Busca café cercano",
        endpoint: "https://example.com/cafe",
        inputSchema: {},
      })
      .returning();

    const [usedSkill] = await dbModule.db
      .insert(dbModule.skills)
      .values({
        name: USED_SKILL_NAME,
        description: "Resume la sesión",
        content: "content",
      })
      .returning();

    const [unusedSkill] = await dbModule.db
      .insert(dbModule.skills)
      .values({
        name: UNUSED_SKILL_NAME,
        description: "No se llama nunca",
        content: "content",
      })
      .returning();

    const [mcpServer] = await dbModule.db
      .insert(dbModule.mcpServers)
      .values({
        name: MCP_SERVER_NAME,
        serverUrl: "https://example.com/mcp",
      })
      .returning();

    await dbModule.db
      .insert(dbModule.agentTools)
      .values({ agentId: agentA.id, toolId: tool.id });
    await dbModule.db.insert(dbModule.agentSkills).values([
      { agentId: agentA.id, skillId: usedSkill.id },
      { agentId: agentA.id, skillId: unusedSkill.id },
    ]);
    await dbModule.db.insert(dbModule.agentMcpTools).values({
      agentId: agentA.id,
      serverId: mcpServer.id,
      toolName: MCP_TOOL_NAME,
    });
    await dbModule.db.insert(dbModule.agentSubAgents).values([
      { parentId: agentA.id, childId: c.id },
      { parentId: agentB.id, childId: agentA.id },
    ]);

    const [run1] = await dbModule.db
      .insert(dbModule.agentRuns)
      .values({
        agentId: agentA.id,
        source: "dashboard",
        durationMs: 120,
        inputTokens: 100,
        outputTokens: 50,
        status: "ok",
      })
      .returning();

    const [run2] = await dbModule.db
      .insert(dbModule.agentRuns)
      .values({
        agentId: agentA.id,
        source: "v1",
        durationMs: 200,
        inputTokens: 200,
        outputTokens: 100,
        status: "ok",
        approvalsRequested: 2,
        approvalsGranted: 1,
      })
      .returning();

    const [run3] = await dbModule.db
      .insert(dbModule.agentRuns)
      .values({
        agentId: agentA.id,
        source: "mcp",
        durationMs: 80,
        inputTokens: 10,
        outputTokens: 5,
        status: "error",
        error: "boom",
      })
      .returning();
    errorRunId = run3.id;

    const [runB] = await dbModule.db
      .insert(dbModule.agentRuns)
      .values({
        agentId: agentB.id,
        source: "dashboard",
        durationMs: 50,
        inputTokens: 15,
        outputTokens: 5,
        status: "ok",
      })
      .returning();

    await dbModule.db.insert(dbModule.agentRunCalls).values([
      {
        runId: run1.id,
        kind: "tool",
        name: httpName,
        status: "ok",
        durationMs: 40,
      },
      {
        runId: run1.id,
        kind: "tool",
        name: ORPHAN_CALL_NAME,
        status: "ok",
        durationMs: 5,
      },
      { runId: run2.id, kind: "tool", name: httpName, status: "denied" },
      {
        runId: run2.id,
        kind: "skill",
        name: USED_SKILL_NAME,
        status: "ok",
        durationMs: 20,
      },
      {
        runId: run3.id,
        kind: "mcp",
        name: mcpName,
        status: "ok",
        durationMs: 15,
      },
      {
        runId: runB.id,
        kind: "sub_agent",
        name: subAgentNameForA,
        status: "ok",
        durationMs: 30,
      },
    ]);
  }, 60000);

  afterAll(async () => {
    await dbModule.closePool();
    await container.stop();
  });

  it("getMetricsData aggregates totals across every agent in the window", async () => {
    const data = await queries.getMetricsData(range);

    expect(data.totals.runs).toBe(4);
    expect(data.totals.errors).toBe(1);
    expect(data.totals.tokens).toBe(485);
  });

  it("getMetricsData byAgent reports configured/unused capabilities keyed by the derived name join", async () => {
    const data = await queries.getMetricsData(range);
    const agentARow = data.byAgent.find((row) => row.agentId === agentA.id);

    expect(agentARow).toBeDefined();
    expect(agentARow?.runs).toBe(3);
    expect(agentARow?.errors).toBe(1);
    expect(agentARow?.tokens).toBe(465);
    expect(agentARow?.configured).toBe(5);
    expect(agentARow?.unused).toHaveLength(2);
    expect(agentARow?.unused.map((row) => row.displayName).sort()).toEqual(
      [UNUSED_CHILD_AGENT_NAME, UNUSED_SKILL_NAME].sort(),
    );
    expect(
      agentARow?.unused.some((row) => row.displayName === CAFE_TOOL_NAME),
    ).toBe(false);
    expect(
      agentARow?.unused.some((row) => row.displayName === USED_SKILL_NAME),
    ).toBe(false);
  });

  it("getMetricsData byTool exposes the derived call name with its distinct sources", async () => {
    const data = await queries.getMetricsData(range);
    const cafeToolRow = data.byTool.find(
      (row) => row.kind === "tool" && row.name === httpName,
    );

    expect(cafeToolRow).toBeDefined();
    expect(cafeToolRow?.calls).toBe(1);
    expect(cafeToolRow?.denied).toBe(1);
    expect(cafeToolRow?.sources).toEqual(["dashboard", "v1"]);
  });

  it("getMetricsData neverRun includes an active agent with zero runs", async () => {
    const data = await queries.getMetricsData(range);

    expect(data.neverRun.map((row) => row.id)).toContain(agentD.id);
  });

  it("getMetricsData daily groups runs by day and source", async () => {
    const data = await queries.getMetricsData(range);

    const dashboardRow = data.daily.find((row) => row.source === "dashboard");
    const v1Row = data.daily.find((row) => row.source === "v1");
    const mcpRow = data.daily.find((row) => row.source === "mcp");

    expect(dashboardRow?.runs).toBe(2);
    expect(v1Row?.runs).toBe(1);
    expect(mcpRow?.runs).toBe(1);
    expect(mcpRow?.errors).toBe(1);
  });

  it("getMetricsData dailyLatency is the true per-day percentile across sources, not the max of per-source p50s", async () => {
    const data = await queries.getMetricsData(range);

    // durations across all 4 runs on this one day: dashboard 120 + 50, v1 200, mcp 80
    expect(data.dailyLatency).toHaveLength(1);
    expect(data.dailyLatency[0]?.p50DurationMs).toBe(100);
    expect(data.dailyLatency[0]?.p95DurationMs).toBe(188);
    // the old bug took max(...) of the per-source p50s grouped in `daily`,
    // which would have reported 200 (v1's own p50) instead of 100
    const maxOfPerSourceP50 = Math.max(
      ...data.daily.map((row) => row.p50DurationMs),
    );
    expect(maxOfPerSourceP50).toBe(200);
    expect(data.dailyLatency[0]?.p50DurationMs).not.toBe(maxOfPerSourceP50);
  });

  it("getAgentMetricsData lists capabilities with configured flags and derived names", async () => {
    const data = await queries.getAgentMetricsData(agentA.id, range);

    const cafeCapability = data?.capabilities.find(
      (row) => row.kind === "tool" && row.name === httpName,
    );
    expect(cafeCapability?.configured).toBe(true);
    expect(cafeCapability?.calls).toBe(1);
    expect(cafeCapability?.denied).toBe(1);
    expect(cafeCapability?.displayName).toBe(CAFE_TOOL_NAME);

    const orphanCapability = data?.capabilities.find(
      (row) => row.name === ORPHAN_CALL_NAME,
    );
    expect(orphanCapability?.configured).toBe(false);
  });

  it("getAgentMetricsData parents reports the calling parent agent and its call count", async () => {
    const data = await queries.getAgentMetricsData(agentA.id, range);

    expect(data?.parents).toHaveLength(1);
    expect(data?.parents[0]).toMatchObject({ id: agentB.id, calls: 1 });
  });

  it("getAgentMetricsData bySource and recentErrors reflect only that agent's runs", async () => {
    const data = await queries.getAgentMetricsData(agentA.id, range);

    const dashboardRow = data?.bySource.find(
      (row) => row.source === "dashboard",
    );
    const v1Row = data?.bySource.find((row) => row.source === "v1");
    const mcpRow = data?.bySource.find((row) => row.source === "mcp");
    expect(dashboardRow?.runs).toBe(1);
    expect(v1Row?.runs).toBe(1);
    expect(mcpRow?.runs).toBe(1);

    expect(data?.recentErrors.map((row) => row.id)).toContain(errorRunId);
  });

  it("getAgentMetricsData dailyLatency reflects only that agent's runs with a true percentile", async () => {
    const data = await queries.getAgentMetricsData(agentA.id, range);

    // agentA's own durations: dashboard 120, v1 200, mcp 80
    expect(data?.dailyLatency).toHaveLength(1);
    expect(data?.dailyLatency[0]?.p50DurationMs).toBe(120);
    expect(data?.dailyLatency[0]?.p95DurationMs).toBe(192);
    const maxOfPerSourceP50 = Math.max(
      ...(data?.daily.map((row) => row.p50DurationMs) ?? []),
    );
    expect(maxOfPerSourceP50).toBe(200);
    expect(data?.dailyLatency[0]?.p50DurationMs).not.toBe(maxOfPerSourceP50);
  });

  it("getAgentMetricsData series has one entry per day in the range", async () => {
    const data = await queries.getAgentMetricsData(agentA.id, range);

    expect(data?.series).toHaveLength(range.days.length);
  });

  it("getAgentMetricsData returns null for a non-uuid id", async () => {
    const data = await queries.getAgentMetricsData("not-a-uuid", range);

    expect(data).toBeNull();
  });

  it("getAgentMetricsData returns null for an unknown uuid", async () => {
    const data = await queries.getAgentMetricsData(randomUUID(), range);

    expect(data).toBeNull();
  });
});
