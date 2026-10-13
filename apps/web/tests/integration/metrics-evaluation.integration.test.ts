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

const DAY_MS = 86_400_000;
const HASH_V1 = "a".repeat(64);
const HASH_V2 = "b".repeat(64);

let container: StartedPostgreSqlContainer;
let dbModule: typeof import("@agentlathe/db");
let queries: typeof import("../../lib/queries-metrics");
let range: MetricsRange;

let agentX: { id: string };
let agentY: { id: string };
let agentZ: { id: string };
let baseNow: number;
let criterionA: { id: string };
let criterionC: { id: string };

describe("evaluation metrics queries (requires Docker)", () => {
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

    const { db, agents, agentVersions, agentRuns, agentCriteria } = dbModule;
    const { runEvaluations } = dbModule;

    const [x] = await db
      .insert(agents)
      .values({ name: "Eval X", slug: "eval-x", model: "test/model" })
      .returning();
    agentX = x;
    const [y] = await db
      .insert(agents)
      .values({ name: "Eval Y", slug: "eval-y", model: "test/model" })
      .returning();
    agentY = y;

    const [v1] = await db
      .insert(agentVersions)
      .values({
        agentId: x.id,
        hash: HASH_V1,
        snapshot: { model: "m", systemPrompt: "Be kind.", maxSteps: 10 },
      })
      .returning();
    const [v2] = await db
      .insert(agentVersions)
      .values({
        agentId: x.id,
        hash: HASH_V2,
        snapshot: { model: "m", systemPrompt: "Be brief.", maxSteps: 10 },
      })
      .returning();
    const [vy] = await db
      .insert(agentVersions)
      .values({ agentId: y.id, hash: "c".repeat(64), snapshot: {} })
      .returning();

    const [a] = await db
      .insert(agentCriteria)
      .values({ agentId: x.id, question: "Greets the user?" })
      .returning();
    criterionA = a;
    const [b] = await db
      .insert(agentCriteria)
      .values({ agentId: x.id, question: "Retired?", isActive: false })
      .returning();
    const [c] = await db
      .insert(agentCriteria)
      .values({ agentId: x.id, question: "New question?" })
      .returning();
    criterionC = c;
    const [cy] = await db
      .insert(agentCriteria)
      .values({ agentId: y.id, question: "Y question?" })
      .returning();

    const now = Date.now();
    baseNow = now;
    const run = async (
      agentId: string,
      versionId: string | null,
      daysAgo: number,
    ) => {
      const [created] = await db
        .insert(agentRuns)
        .values({
          agentId,
          agentVersionId: versionId,
          source: "v1",
          durationMs: 10,
          createdAt: new Date(now - daysAgo * DAY_MS),
        })
        .returning();
      return created.id;
    };
    const verdict = (
      runId: string,
      criterion: { id: string },
      question: string,
      status: string,
      reviewedVerdict?: string,
    ) => ({
      runId,
      criterionId: criterion.id,
      questionSnapshot: question,
      status,
      reviewedVerdict,
    });

    const r1 = await run(x.id, v1.id, 3);
    const r2 = await run(x.id, v1.id, 3);
    const r3 = await run(x.id, v1.id, 3);
    const r4 = await run(x.id, v2.id, 1);
    const r5 = await run(x.id, v2.id, 1);
    const r6 = await run(x.id, v2.id, 1);
    const r7 = await run(x.id, v2.id, 1);
    const r8 = await run(x.id, v1.id, 60);
    const r9 = await run(x.id, v2.id, 1);
    const ry = await run(y.id, vy.id, 2);
    const r10 = await run(x.id, v1.id, 60);
    const r11 = await run(x.id, v2.id, 1);
    const r12 = await run(x.id, v2.id, 1);

    const [z] = await db
      .insert(agents)
      .values({ name: "Eval Z", slug: "eval-z", model: "test/model" })
      .returning();
    agentZ = z;
    const [za] = await db
      .insert(agentVersions)
      .values({ agentId: z.id, hash: "d".repeat(64), snapshot: {} })
      .returning();
    const [zb] = await db
      .insert(agentVersions)
      .values({ agentId: z.id, hash: "e".repeat(64), snapshot: {} })
      .returning();
    const [cz] = await db
      .insert(agentCriteria)
      .values({ agentId: z.id, question: "Z question?" })
      .returning();
    const zVerdicts = [];
    for (const [versionId, daysAgo, status] of [
      [za.id, 20, "pass"],
      [zb.id, 10, "fail"],
      [za.id, 1, "pass"],
    ] as const) {
      for (let index = 0; index < 6; index++) {
        const zr = await run(z.id, versionId, daysAgo);
        zVerdicts.push(verdict(zr, cz, "Z question?", status));
      }
    }
    await db.insert(runEvaluations).values(zVerdicts);

    await db
      .insert(runEvaluations)
      .values([
        verdict(r1, criterionA, "Greets the user?", "pass"),
        verdict(r1, criterionC, "Old question?", "pass"),
        verdict(r2, criterionA, "Greets the user?", "fail", "pass"),
        verdict(r2, criterionC, "New question?", "pass"),
        verdict(r3, criterionA, "Greets the user?", "needs_review"),
        verdict(r4, criterionA, "Greets the user?", "pass", "pass"),
        verdict(r4, b, "Retired?", "pass"),
        verdict(r5, criterionA, "Greets the user?", "needs_review", "fail"),
        verdict(r6, criterionA, "Greets the user?", "not_applicable"),
        verdict(r7, criterionA, "Greets the user?", "error"),
        verdict(r8, criterionA, "Greets the user?", "fail"),
        verdict(r9, criterionA, "Greets the user?", "skipped"),
        verdict(ry, cy, "Y question?", "pass"),
        verdict(r10, criterionA, "Greets the user?", "needs_review"),
        verdict(r10, criterionC, "New question?", "needs_review"),
        verdict(r11, criterionC, "Old question?", "needs_review"),
        verdict(r12, b, "Retired?", "needs_review"),
      ]);
  }, 60000);

  afterAll(async () => {
    await dbModule.closePool();
    await container.stop();
  });

  it("orders versions by first run in range and drops runs outside it", async () => {
    const data = await queries.getAgentMetricsData(agentX.id, range);
    const evaluation = data?.evaluation;

    expect(evaluation?.versions.map((version) => version.shortHash)).toEqual([
      "aaaaaaaa",
      "bbbbbbbb",
    ]);
    expect(evaluation?.versions.map((version) => version.newest)).toEqual([
      false,
      true,
    ]);
    expect(evaluation?.markers.map((marker) => marker.shortHash)).toEqual([
      "aaaaaaaa",
      "bbbbbbbb",
    ]);
  });

  it("describes what changed in each version against the one before it", async () => {
    const data = await queries.getAgentMetricsData(agentX.id, range);
    const [first, second] = data?.evaluation.versions ?? [];

    expect(first?.changes).toBeNull();
    expect(second?.changes?.previousShortHash).toBe("aaaaaaaa");
    expect(second?.changes?.diff.summary).toBe("prompt edited");
  });

  it("spans each version from its first to its last run in the range", async () => {
    const data = await queries.getAgentMetricsData(agentX.id, range);
    const [first, second] = data?.evaluation.versions ?? [];

    expect(first?.lastRunAt.getTime()).toBe(baseNow - 3 * DAY_MS);
    expect(second?.lastRunAt.getTime()).toBe(baseNow - DAY_MS);
  });

  it("makes the version that ran most recently the newest after a revert", async () => {
    const data = await queries.getAgentMetricsData(agentZ.id, range);
    const evaluation = data?.evaluation;

    expect(evaluation?.versions.map((version) => version.shortHash)).toEqual([
      "eeeeeeee",
      "dddddddd",
    ]);
    expect(evaluation?.versions.at(-1)?.newest).toBe(true);
    expect(evaluation?.rows[0]?.delta).toEqual({ kind: "points", points: 100 });
  });

  it("counts runs awaiting review across all time, for active criteria on their current question", async () => {
    const data = await queries.getMetricsData(range);

    expect(data.evaluation.awaitingReviewRuns).toBe(2);
  });

  it("counts reviewed verdicts over the judge and excludes n/a, skipped, error and out-of-range runs", async () => {
    const data = await queries.getAgentMetricsData(agentX.id, range);
    const rowA = data?.evaluation.rows.find((row) => row.id === criterionA.id);

    expect(rowA?.cells[0]).toEqual({
      judged: 2,
      needsReview: 1,
      passRate: 1,
    });
    expect(rowA?.cells[1]).toEqual({
      judged: 2,
      needsReview: 0,
      passRate: 0.5,
    });
    expect(rowA?.delta).toEqual({ kind: "small_sample" });
  });

  it("omits inactive criteria and reports how many were hidden", async () => {
    const data = await queries.getAgentMetricsData(agentX.id, range);

    expect(data?.evaluation.rows.map((row) => row.id)).toEqual([
      criterionA.id,
      criterionC.id,
    ]);
    expect(data?.evaluation.inactiveCriteria).toBe(1);
  });

  it("only counts verdicts for the criterion's current question", async () => {
    const data = await queries.getAgentMetricsData(agentX.id, range);
    const rowC = data?.evaluation.rows.find((row) => row.id === criterionC.id);

    expect(rowC?.total).toEqual({ judged: 1, needsReview: 0, passRate: 1 });
  });

  it("measures judge vs human agreement and how unsure verdicts were resolved", async () => {
    const data = await queries.getAgentMetricsData(agentX.id, range);

    expect(data?.evaluation.agreement).toMatchObject({
      judgedReviewed: 2,
      agreed: 1,
      resolvedAsPass: 0,
      resolvedAsFail: 1,
      enough: false,
    });
  });

  it("builds a daily series keyed by the run's day", async () => {
    const data = await queries.getAgentMetricsData(agentX.id, range);
    const points = data?.evaluation.points ?? [];

    expect(points).toHaveLength(range.days.length);
    expect(points.filter((point) => point.c0 !== null)).toHaveLength(2);
  });

  it("scopes the evaluation to the agent", async () => {
    const data = await queries.getAgentMetricsData(agentY.id, range);

    expect(data?.evaluation.versions).toHaveLength(1);
    expect(data?.evaluation.rows).toHaveLength(1);
    expect(data?.evaluation.rows[0]?.total.passRate).toBe(1);
  });

  it("summarizes the pass rate overall and per agent for the global page", async () => {
    const data = await queries.getMetricsData(range);

    expect(data.evaluation.byAgent[agentX.id]).toEqual({
      pass: 4,
      fail: 1,
      needsReview: 1,
      passRate: 0.8,
    });
    expect(data.evaluation.byAgent[agentY.id]?.pass).toBe(1);
    expect(data.evaluation.overall).toMatchObject({
      pass: 17,
      fail: 7,
      needsReview: 1,
    });
  });
});
