import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ after: vi.fn() }));

const migrationsFolder = fileURLToPath(
  new URL("../../../../packages/db/drizzle", import.meta.url),
);

let container: StartedPostgreSqlContainer;
let dbModule: typeof import("@agentlathe/db");
let queries: typeof import("../../lib/queries");

async function makeAgentWithRuns(name: string, runs = 1) {
  const [agent] = await dbModule.db
    .insert(dbModule.agents)
    .values({ name, slug: dbModule.agentSlug(name), model: "test/model" })
    .returning();
  await dbModule.db.insert(dbModule.agentRuns).values(
    Array.from({ length: runs }, () => ({
      agentId: agent.id,
      source: "v1",
      durationMs: 5,
    })),
  );
  return agent;
}

async function makeAgent(name: string, isActive = true) {
  const [agent] = await dbModule.db
    .insert(dbModule.agents)
    .values({
      name,
      slug: dbModule.agentSlug(name),
      model: "test/model",
      isActive,
    })
    .returning();
  return agent;
}

async function makeTool(name: string, isActive = true) {
  const [tool] = await dbModule.db
    .insert(dbModule.tools)
    .values({
      name,
      description: "d",
      endpoint: "https://example.com/tool",
      inputSchema: {},
      isActive,
    })
    .returning();
  return tool;
}

async function makeSkill(name: string, isActive = true) {
  const [skill] = await dbModule.db
    .insert(dbModule.skills)
    .values({ name, description: "d", content: "c", isActive })
    .returning();
  return skill;
}

async function makeMcpServer(
  name: string,
  overrides: { isActive?: boolean; authConfig?: unknown } = {},
) {
  const [server] = await dbModule.db
    .insert(dbModule.mcpServers)
    .values({ name, serverUrl: "https://example.com/mcp", ...overrides })
    .returning();
  return server;
}

async function makeRun(
  agentId: string,
  overrides: Partial<typeof dbModule.agentRuns.$inferInsert> = {},
) {
  const [run] = await dbModule.db
    .insert(dbModule.agentRuns)
    .values({ agentId, source: "dashboard", durationMs: 5, ...overrides })
    .returning();
  return run;
}

async function makeDraft(
  runId: string,
  overrides: Partial<typeof dbModule.fixDrafts.$inferInsert> = {},
) {
  const [draft] = await dbModule.db
    .insert(dbModule.fixDrafts)
    .values({
      runId,
      messageId: "msg-1",
      anchor: { type: "turn" },
      category: "prompt",
      rationale: "why",
      ...overrides,
    })
    .returning();
  return draft;
}

describe("queries (requires Docker)", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").start();
    process.env.DATABASE_URL = container.getConnectionUri();

    dbModule = await import("@agentlathe/db");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(drizzle(dbModule.getPool()), { migrationsFolder });

    queries = await import("../../lib/queries");
  }, 60000);

  afterAll(async () => {
    await dbModule.closePool();
    await container.stop();
  });

  describe("listRunsPage", () => {
    it("q with an escaped `%`: matches the literal `%` and NOT every row", async () => {
      await Promise.all([
        makeAgentWithRuns("litpct 50% off"),
        makeAgentWithRuns("litpct clean"),
      ]);

      const { rows, total } = await queries.listRunsPage({
        q: "%",
        limit: 20,
        offset: 0,
      });

      expect(rows.map((row) => row.agentName)).toEqual(["litpct 50% off"]);
      expect(total).toBe(1);
    });

    it("q with an escaped `_`: matches the literal `_` and not a wildcard", async () => {
      await Promise.all([
        makeAgentWithRuns("undmark a_b"),
        makeAgentWithRuns("undmark axb"),
      ]);

      const { rows, total } = await queries.listRunsPage({
        q: "undmark a_b",
        limit: 20,
        offset: 0,
      });

      expect(rows.map((row) => row.agentName)).toEqual(["undmark a_b"]);
      expect(total).toBe(1);
    });

    it("total reflects the filtered total while rows respects the limit", async () => {
      await makeAgentWithRuns("totalmark agent", 5);

      const { rows, total } = await queries.listRunsPage({
        q: "totalmark",
        limit: 2,
        offset: 0,
      });

      expect(rows).toHaveLength(2);
      expect(total).toBe(5);
    });

    it("page out of range: offset > total → empty rows but a valid total", async () => {
      await makeAgentWithRuns("rangemark agent", 3);

      const { rows, total } = await queries.listRunsPage({
        q: "rangemark",
        limit: 10,
        offset: 100,
      });

      expect(rows).toEqual([]);
      expect(total).toBe(3);
    });

    it("q longer than 100 chars is truncated: the extra tail does not prevent the match", async () => {
      const name = `qlen${"a".repeat(100)}`;
      await makeAgentWithRuns(name);

      const { rows, total } = await queries.listRunsPage({
        q: `${name}${"Z".repeat(20)}`,
        limit: 20,
        offset: 0,
      });

      expect(rows.map((row) => row.agentName)).toEqual([name]);
      expect(total).toBe(1);
    });

    it("filters by source", async () => {
      const agent = await makeAgentWithRuns("sourcemark agent");
      await dbModule.db.insert(dbModule.agentRuns).values({
        agentId: agent.id,
        source: "dashboard",
        durationMs: 5,
      });

      const { rows, total } = await queries.listRunsPage({
        q: "sourcemark",
        source: "dashboard",
        limit: 20,
        offset: 0,
      });

      expect(total).toBe(1);
      expect(rows[0].source).toBe("dashboard");
    });
  });

  describe("getRunForReview", () => {
    it("returns undefined for a non-uuid id", async () => {
      expect(await queries.getRunForReview("not-a-uuid")).toBeUndefined();
    });

    it("returns undefined for a valid unknown uuid", async () => {
      expect(await queries.getRunForReview(randomUUID())).toBeUndefined();
    });

    it("joins the agent name and transcript, and orders drafts by createdAt", async () => {
      const agent = await makeAgent("review agent");
      const run = await makeRun(agent.id, {
        source: "v1",
        status: "error",
        error: "boom",
      });
      await dbModule.db.insert(dbModule.runTranscripts).values({
        runId: run.id,
        input: [{ role: "user", content: "hi" }],
        output: [{ role: "assistant", content: "hello" }],
      });
      const draftA = await makeDraft(run.id, { rationale: "first" });
      const draftB = await makeDraft(run.id, { rationale: "second" });

      const result = await queries.getRunForReview(run.id);

      expect(result?.agentName).toBe("review agent");
      expect(result?.status).toBe("error");
      expect(result?.input).toEqual([{ role: "user", content: "hi" }]);
      expect(result?.output).toEqual([{ role: "assistant", content: "hello" }]);
      expect(result?.drafts.map((d) => d.id)).toEqual([draftA.id, draftB.id]);
    });

    it("still returns the run when it has no transcript or drafts", async () => {
      const agent = await makeAgent("review agent no transcript");
      const run = await makeRun(agent.id);

      const result = await queries.getRunForReview(run.id);

      expect(result?.input).toBeNull();
      expect(result?.output).toBeNull();
      expect(result?.drafts).toEqual([]);
      expect(result?.versionHash).toBeNull();
    });

    it("returns the hash and snapshot of the agent version the run used", async () => {
      const agent = await makeAgent("review agent versioned");
      const snapshot = { model: "m", systemPrompt: "Be kind." };
      const [version] = await dbModule.db
        .insert(dbModule.agentVersions)
        .values({ agentId: agent.id, hash: "a".repeat(64), snapshot })
        .returning();
      const run = await makeRun(agent.id, { agentVersionId: version.id });

      const result = await queries.getRunForReview(run.id);

      expect(result?.versionHash).toBe("a".repeat(64));
      expect(result?.versionSnapshot).toEqual(snapshot);
    });
  });

  describe("getAgentDetail", () => {
    it("returns null for a non-uuid id", async () => {
      expect(await queries.getAgentDetail("not-a-uuid")).toBeNull();
    });

    it("returns null for a valid unknown uuid", async () => {
      expect(await queries.getAgentDetail(randomUUID())).toBeNull();
    });

    it("resolves skills, tools, grouped mcp tools and sub-agents, and flags inactive refs as warnings", async () => {
      const agent = await makeAgent("detail agent");
      const activeSkill = await makeSkill("detail active skill");
      const inactiveSkill = await makeSkill("detail inactive skill", false);
      const activeTool = await makeTool("detail active tool");
      const inactiveTool = await makeTool("detail inactive tool", false);
      const activeMcp = await makeMcpServer("detail active mcp");
      const inactiveMcp = await makeMcpServer("detail inactive mcp", {
        isActive: false,
      });
      const activeSub = await makeAgent("detail active sub");
      const inactiveSub = await makeAgent("detail inactive sub", false);

      await Promise.all([
        dbModule.db.insert(dbModule.agentSkills).values([
          { agentId: agent.id, skillId: activeSkill.id },
          { agentId: agent.id, skillId: inactiveSkill.id },
        ]),
        dbModule.db.insert(dbModule.agentTools).values([
          { agentId: agent.id, toolId: activeTool.id },
          { agentId: agent.id, toolId: inactiveTool.id },
        ]),
        dbModule.db.insert(dbModule.agentMcpTools).values([
          { agentId: agent.id, serverId: activeMcp.id, toolName: "read" },
          { agentId: agent.id, serverId: activeMcp.id, toolName: "write" },
          {
            agentId: agent.id,
            serverId: inactiveMcp.id,
            toolName: "deploy",
            needsApproval: true,
          },
        ]),
        dbModule.db.insert(dbModule.agentSubAgents).values([
          { parentId: agent.id, childId: activeSub.id },
          { parentId: agent.id, childId: inactiveSub.id },
        ]),
      ]);

      const detail = await queries.getAgentDetail(agent.id);

      expect(detail?.skills.map((row) => row.id).sort()).toEqual(
        [activeSkill.id, inactiveSkill.id].sort(),
      );
      expect(detail?.tools.map((row) => row.id).sort()).toEqual(
        [activeTool.id, inactiveTool.id].sort(),
      );

      const activeGroup = detail?.mcpTools.find(
        (group) => group.serverId === activeMcp.id,
      );
      expect(activeGroup?.status).toBe("ok");
      expect(activeGroup?.tools.map((t) => t.name).sort()).toEqual([
        "read",
        "write",
      ]);
      const inactiveGroup = detail?.mcpTools.find(
        (group) => group.serverId === inactiveMcp.id,
      );
      expect(inactiveGroup?.status).toBe("inactive");
      expect(inactiveGroup?.tools).toEqual([
        { name: "deploy", needsApproval: true },
      ]);

      expect(detail?.subAgents.map((row) => row.id).sort()).toEqual(
        [activeSub.id, inactiveSub.id].sort(),
      );

      expect(detail?.warnings).toEqual(
        expect.arrayContaining([
          { type: "skill", id: inactiveSkill.id, name: inactiveSkill.name },
          { type: "tool", id: inactiveTool.id, name: inactiveTool.name },
          {
            type: "mcp_server",
            id: inactiveMcp.id,
            name: inactiveMcp.name,
          },
          {
            type: "sub_agent",
            id: inactiveSub.id,
            name: inactiveSub.name,
          },
        ]),
      );
      expect(detail?.warnings.some((w) => w.id === activeSkill.id)).toBe(false);
    });
  });

  describe("getAgentFormCatalogs", () => {
    it("only returns active skills, tools, mcp servers and agents", async () => {
      await makeSkill("catalog active skill");
      await makeSkill("catalog inactive skill", false);
      await makeTool("catalog active tool");
      await makeTool("catalog inactive tool", false);
      await makeMcpServer("catalog active mcp");
      await makeMcpServer("catalog inactive mcp", { isActive: false });

      const catalogs = await queries.getAgentFormCatalogs();

      expect(
        catalogs.skills.some((s) => s.name === "catalog active skill"),
      ).toBe(true);
      expect(
        catalogs.skills.some((s) => s.name === "catalog inactive skill"),
      ).toBe(false);
      expect(catalogs.tools.some((t) => t.name === "catalog active tool")).toBe(
        true,
      );
      expect(
        catalogs.tools.some((t) => t.name === "catalog inactive tool"),
      ).toBe(false);
      expect(
        catalogs.mcpServers.some((m) => m.name === "catalog active mcp"),
      ).toBe(true);
      expect(
        catalogs.mcpServers.some((m) => m.name === "catalog inactive mcp"),
      ).toBe(false);
    });

    it("subAgentCandidates excludes the given agent id, and includes it when omitted", async () => {
      const agent = await makeAgent("catalog self agent");

      const withoutExclude = await queries.getAgentFormCatalogs();
      expect(
        withoutExclude.subAgentCandidates.some((a) => a.id === agent.id),
      ).toBe(true);

      const withExclude = await queries.getAgentFormCatalogs(agent.id);
      expect(
        withExclude.subAgentCandidates.some((a) => a.id === agent.id),
      ).toBe(false);
    });
  });

  describe("getDashboardData", () => {
    it("counts reflect newly inserted agents, tools, skills, mcp servers and runs", async () => {
      const before = await queries.getDashboardData();

      const agent = await makeAgent("dashboard counts agent");
      await makeTool("dashboard counts tool");
      await makeSkill("dashboard counts skill");
      await makeMcpServer("dashboard counts mcp");
      await makeRun(agent.id);

      const after = await queries.getDashboardData();

      expect(after.counts.agents).toBe(before.counts.agents + 1);
      expect(after.counts.activeAgents).toBe(before.counts.activeAgents + 1);
      expect(after.counts.tools).toBe(before.counts.tools + 1);
      expect(after.counts.skills).toBe(before.counts.skills + 1);
      expect(after.counts.mcp).toBe(before.counts.mcp + 1);
      expect(after.counts.runs).toBe(before.counts.runs + 1);
    });

    it("needsReview includes error runs and runs with an open draft, but not a plain ok run or a dismissed-only draft", async () => {
      const before = await queries.getDashboardData();

      const agent = await makeAgent("dashboard needs review agent");
      const errorRun = await makeRun(agent.id, {
        status: "error",
        error: "boom",
      });
      const openDraftRun = await makeRun(agent.id);
      await makeDraft(openDraftRun.id);
      const dismissedDraftRun = await makeRun(agent.id);
      await makeDraft(dismissedDraftRun.id, { status: "dismissed" });
      const cleanRun = await makeRun(agent.id);

      const after = await queries.getDashboardData();
      const ids = after.needsReview.map((row) => row.id);

      expect(ids).toContain(errorRun.id);
      expect(ids).toContain(openDraftRun.id);
      expect(ids).not.toContain(dismissedDraftRun.id);
      expect(ids).not.toContain(cleanRun.id);
      expect(after.needsReviewCount).toBe(before.needsReviewCount + 2);

      const reviewRow = after.needsReview.find(
        (row) => row.id === openDraftRun.id,
      );
      expect(reviewRow?.openDrafts).toBe(1);
    });

    it("agentIssues reports an agent with an inactive tool reference", async () => {
      const agent = await makeAgent("dashboard broken ref agent");
      const inactiveTool = await makeTool("dashboard broken tool", false);
      await dbModule.db
        .insert(dbModule.agentTools)
        .values({ agentId: agent.id, toolId: inactiveTool.id });

      const data = await queries.getDashboardData();
      const issue = data.agentIssues.find((row) => row.id === agent.id);

      expect(issue?.brokenRefs).toBe(1);
    });

    it("activity aggregates runs from the last 7 days and excludes older ones", async () => {
      const before = await queries.getDashboardData();

      const agent = await makeAgent("dashboard activity agent");
      await makeRun(agent.id, { status: "error" });
      await makeRun(agent.id, {
        createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      });

      const after = await queries.getDashboardData();
      const totalDaily = after.activity.daily.reduce(
        (sum, row) => sum + row.runs,
        0,
      );

      expect(after.activity.runs).toBe(totalDaily);
      // only the fresh run counts: the 10-day-old one falls outside the 7-day window.
      expect(after.activity.runs).toBe(before.activity.runs + 1);
      expect(after.activity.errors).toBe(before.activity.errors + 1);
    });
  });

  describe("getAgentCriteria and getCriteriaCopySources", () => {
    const DAY = 24 * 60 * 60 * 1000;

    async function makeCriterion(
      agentId: string,
      question: string,
      overrides: Partial<typeof dbModule.agentCriteria.$inferInsert> = {},
    ) {
      const [criterion] = await dbModule.db
        .insert(dbModule.agentCriteria)
        .values({ agentId, question, ...overrides })
        .returning();
      return criterion;
    }

    async function evaluate(
      criterionId: string,
      status: string,
      overrides: Partial<typeof dbModule.runEvaluations.$inferInsert> = {},
      runOverrides: Partial<typeof dbModule.agentRuns.$inferInsert> = {},
    ) {
      const agentRun = await dbModule.db
        .select({
          agentId: dbModule.agentCriteria.agentId,
          question: dbModule.agentCriteria.question,
        })
        .from(dbModule.agentCriteria)
        .where(eq(dbModule.agentCriteria.id, criterionId))
        .then(([row]) => row);
      const run = await makeRun(agentRun.agentId, runOverrides);
      await dbModule.db.insert(dbModule.runEvaluations).values({
        runId: run.id,
        criterionId,
        questionSnapshot: agentRun.question,
        status,
        ...overrides,
      });
      return run;
    }

    it("returns every criterion with 30-day stats, counting unreviewed needs_review and human verdicts", async () => {
      const agent = await makeAgent("criteria stats agent");
      const other = await makeAgent("criteria stats other agent");
      const judged = await makeCriterion(agent.id, "Was it confirmed?");
      const inactive = await makeCriterion(agent.id, "Inactive one", {
        isActive: false,
      });
      const otherCriterion = await makeCriterion(other.id, "Not mine");

      const originRun = await evaluate(judged.id, "pass");
      await evaluate(judged.id, "pass");
      await evaluate(judged.id, "fail");
      await evaluate(judged.id, "needs_review");
      await evaluate(judged.id, "needs_review", { reviewedVerdict: "pass" });
      await evaluate(
        judged.id,
        "pass",
        {},
        { createdAt: new Date(Date.now() - 40 * DAY) },
      );
      await evaluate(judged.id, "pass", {
        createdAt: new Date(Date.now() - 40 * DAY),
      });
      await evaluate(judged.id, "fail", {
        questionSnapshot: "An older wording",
      });
      await evaluate(judged.id, "needs_review", {
        questionSnapshot: "An older wording",
      });
      await evaluate(judged.id, "not_applicable");
      await evaluate(judged.id, "skipped", { skipReason: "too_long" });
      await evaluate(otherCriterion.id, "fail");

      const draft = await makeDraft(originRun.id);
      const promoted = await makeCriterion(agent.id, "Promoted", {
        sourceFixDraftId: draft.id,
      });

      const { criteria, lastEvaluationError } = await queries.getAgentCriteria(
        agent.id,
      );

      expect(criteria.map((criterion) => criterion.question)).toEqual([
        "Was it confirmed?",
        "Inactive one",
        "Promoted",
      ]);
      expect(criteria[0].stats).toEqual({
        pass: 4,
        fail: 1,
        needsReview: 1,
        passRate: 0.8,
      });
      expect(criteria[1]).toMatchObject({
        id: inactive.id,
        isActive: false,
        stats: { pass: 0, fail: 0, needsReview: 0, passRate: null },
      });
      expect(criteria[0].sourceRunId).toBeNull();
      expect(criteria[2]).toMatchObject({
        id: promoted.id,
        sourceFixDraftId: draft.id,
        sourceRunId: originRun.id,
      });
      expect(lastEvaluationError).toBeNull();
    });

    it("ignores errors from inactive criteria in the last-error notice", async () => {
      const agent = await makeAgent("criteria inactive error agent");
      const retired = await makeCriterion(agent.id, "Retired", {
        isActive: false,
      });
      const live = await makeCriterion(agent.id, "Live");
      await evaluate(live.id, "pass", {
        createdAt: new Date(Date.now() - 5000),
      });
      await evaluate(retired.id, "error", { error: "boom" });

      expect(
        (await queries.getAgentCriteria(agent.id)).lastEvaluationError,
      ).toBeNull();
    });

    it("has no pass rate when only unjudged verdicts exist", async () => {
      const agent = await makeAgent("criteria unjudged agent");
      const criterion = await makeCriterion(agent.id, "Only review");
      await evaluate(criterion.id, "needs_review");

      const { criteria } = await queries.getAgentCriteria(agent.id);

      expect(criteria[0].stats).toEqual({
        pass: 0,
        fail: 0,
        needsReview: 1,
        passRate: null,
      });
    });

    it("reports the latest evaluation error only while it is the latest row", async () => {
      const agent = await makeAgent("criteria error agent");
      const criterion = await makeCriterion(agent.id, "Errors");
      const at = new Date(Date.now() - 1000);
      await evaluate(criterion.id, "pass", {
        createdAt: new Date(Date.now() - 5000),
      });
      await evaluate(criterion.id, "error", {
        error: "Decisions API returned 404",
        createdAt: at,
      });

      const failing = await queries.getAgentCriteria(agent.id);
      expect(failing.lastEvaluationError).toEqual({
        message: "Decisions API returned 404",
        at,
      });

      await evaluate(criterion.id, "pass");
      const recovered = await queries.getAgentCriteria(agent.id);
      expect(recovered.lastEvaluationError).toBeNull();
    });

    it("answers empty for a malformed id instead of querying", async () => {
      expect(await queries.getAgentCriteria("not-a-uuid")).toEqual({
        criteria: [],
        lastEvaluationError: null,
      });
      expect(await queries.getCriteriaCopySources("not-a-uuid")).toEqual([]);
    });

    it("lists the other agents that have criteria, grouped, never the excluded agent", async () => {
      const target = await makeAgent("copy target agent");
      const source = await makeAgent("copy source agent");
      await makeAgent("copy agent without criteria");
      await makeCriterion(target.id, "Target own");
      await makeCriterion(source.id, "First", {
        passDescription: "good",
        failDescription: "bad",
        appliesWhen: "when",
        failBelow: 0.1,
        passAbove: 0.9,
      });
      await makeCriterion(source.id, "Second");
      await makeCriterion(source.id, "Retired", { isActive: false });

      const sources = await queries.getCriteriaCopySources(target.id);
      const mine = sources.find((entry) => entry.agentId === source.id);

      expect(sources.some((entry) => entry.agentId === target.id)).toBe(false);
      expect(
        sources.some(
          (entry) => entry.agentName === "copy agent without criteria",
        ),
      ).toBe(false);
      expect(mine?.agentName).toBe("copy source agent");
      expect(mine?.criteria.map((criterion) => criterion.question)).toEqual([
        "First",
        "Second",
      ]);
      expect(mine?.criteria[0]).toMatchObject({
        passDescription: "good",
        failDescription: "bad",
        appliesWhen: "when",
        failBelow: 0.1,
        passAbove: 0.9,
      });
    });
  });

  describe("evaluations on the run page and the runs list", () => {
    async function makeCriterion(
      agentId: string,
      question: string,
      overrides: Partial<typeof dbModule.agentCriteria.$inferInsert> = {},
    ) {
      const [criterion] = await dbModule.db
        .insert(dbModule.agentCriteria)
        .values({ agentId, question, ...overrides })
        .returning();
      return criterion;
    }

    async function addVerdict(
      runId: string,
      criterion: { id: string; question: string },
      status: string,
      overrides: Partial<typeof dbModule.runEvaluations.$inferInsert> = {},
    ) {
      const [evaluation] = await dbModule.db
        .insert(dbModule.runEvaluations)
        .values({
          runId,
          criterionId: criterion.id,
          questionSnapshot: criterion.question,
          status,
          ...overrides,
        })
        .returning();
      return evaluation;
    }

    async function addTranscript(runId: string) {
      await dbModule.db
        .insert(dbModule.runTranscripts)
        .values({ runId, input: [], output: [] });
    }

    describe("getRunForReview", () => {
      it("returns each verdict with its criterion's current wording and state, in criterion order", async () => {
        const agent = await makeAgent("review verdicts agent");
        const first = await makeCriterion(agent.id, "Was it polite?", {
          createdAt: new Date("2026-01-01T00:00:00Z"),
        });
        const second = await makeCriterion(agent.id, "Was it brief now?", {
          isActive: false,
          createdAt: new Date("2026-01-02T00:00:00Z"),
        });
        const run = await makeRun(agent.id);
        await addTranscript(run.id);
        await addVerdict(run.id, second, "skipped", {
          questionSnapshot: "Was it brief?",
          skipReason: "too_long",
        });
        const judged = await addVerdict(run.id, first, "fail", {
          pPass: 0.12,
          reviewedVerdict: "pass",
        });

        const result = await queries.getRunForReview(run.id);

        expect(result?.hasTranscript).toBe(true);
        expect(result?.hasActiveCriteria).toBe(true);
        expect(result?.evaluations).toEqual([
          {
            id: judged.id,
            criterionId: first.id,
            questionSnapshot: "Was it polite?",
            currentQuestion: "Was it polite?",
            criterionActive: true,
            status: "fail",
            pPass: expect.closeTo(0.12, 5),
            skipReason: null,
            error: null,
            reviewedVerdict: "pass",
          },
          expect.objectContaining({
            criterionId: second.id,
            questionSnapshot: "Was it brief?",
            currentQuestion: "Was it brief now?",
            criterionActive: false,
            status: "skipped",
            skipReason: "too_long",
            pPass: null,
          }),
        ]);
      });

      it("reports no transcript, no verdicts and no active criteria for a bare run", async () => {
        const agent = await makeAgent("review verdicts bare agent");
        await makeCriterion(agent.id, "Retired", { isActive: false });
        const run = await makeRun(agent.id);

        const result = await queries.getRunForReview(run.id);

        expect(result?.hasTranscript).toBe(false);
        expect(result?.hasActiveCriteria).toBe(false);
        expect(result?.evaluations).toEqual([]);
      });
    });

    describe("listRunsPage", () => {
      let seeded = 0;

      async function seed() {
        seeded += 1;
        const q = `evalfilter${seeded}x`;
        const agent = await makeAgent(`${q} agent`);
        const c1 = await makeCriterion(agent.id, "Q1");
        const c2 = await makeCriterion(agent.id, "Q2");
        const runs = {
          failed: await makeRun(agent.id),
          unsure: await makeRun(agent.id),
          unsureReviewed: await makeRun(agent.id),
          failOverruled: await makeRun(agent.id),
          passOverruled: await makeRun(agent.id),
          gap: await makeRun(agent.id),
          noTranscript: await makeRun(agent.id),
          clean: await makeRun(agent.id),
          mixed: await makeRun(agent.id, { source: "v1" }),
        };
        await Promise.all(
          [runs.gap, runs.clean, runs.mixed, runs.failed].map((run) =>
            addTranscript(run.id),
          ),
        );
        await addVerdict(runs.failed.id, c1, "fail");
        await addVerdict(runs.unsure.id, c1, "needs_review");
        await addVerdict(runs.unsureReviewed.id, c1, "needs_review", {
          reviewedVerdict: "pass",
        });
        await addVerdict(runs.failOverruled.id, c1, "fail", {
          reviewedVerdict: "pass",
        });
        await addVerdict(runs.passOverruled.id, c1, "pass", {
          reviewedVerdict: "fail",
        });
        await addVerdict(runs.clean.id, c1, "pass");
        await addVerdict(runs.clean.id, c2, "not_applicable");
        await addVerdict(runs.mixed.id, c1, "fail");
        await addVerdict(runs.mixed.id, c2, "needs_review");
        return { runs, q };
      }

      const idsOf = (rows: { id: string }[]) =>
        rows.map((row) => row.id).sort();

      it("aggregates each run's verdicts, letting a human review override the judge", async () => {
        const { runs, q } = await seed();

        const { rows } = await queries.listRunsPage({
          q,
          limit: 50,
          offset: 0,
        });
        const summary = (run: { id: string }) => {
          const row = rows.find((candidate) => candidate.id === run.id);
          return (
            row && {
              total: row.evaluationTotal,
              failed: row.evaluationFailed,
              needsReview: row.evaluationNeedsReview,
              clear: row.evaluationClear,
            }
          );
        };

        expect(summary(runs.failed)).toEqual({
          total: 1,
          failed: 1,
          needsReview: 0,
          clear: 0,
        });
        expect(summary(runs.unsure)).toEqual({
          total: 1,
          failed: 0,
          needsReview: 1,
          clear: 0,
        });
        expect(summary(runs.unsureReviewed)).toEqual({
          total: 1,
          failed: 0,
          needsReview: 0,
          clear: 1,
        });
        expect(summary(runs.failOverruled)).toEqual({
          total: 1,
          failed: 0,
          needsReview: 0,
          clear: 1,
        });
        expect(summary(runs.passOverruled)).toEqual({
          total: 1,
          failed: 1,
          needsReview: 0,
          clear: 0,
        });
        expect(summary(runs.clean)).toEqual({
          total: 2,
          failed: 0,
          needsReview: 0,
          clear: 2,
        });
        expect(summary(runs.mixed)).toEqual({
          total: 2,
          failed: 1,
          needsReview: 1,
          clear: 0,
        });
        expect(summary(runs.gap)).toEqual({
          total: 0,
          failed: 0,
          needsReview: 0,
          clear: 0,
        });
      });

      it("needs_review keeps only runs with an unreviewed needs_review verdict", async () => {
        const { runs, q } = await seed();

        const { rows, total, needsReviewTotal } = await queries.listRunsPage({
          q,
          evaluation: "needs_review",
          limit: 50,
          offset: 0,
        });

        expect(idsOf(rows)).toEqual(idsOf([runs.unsure, runs.mixed]));
        expect(total).toBe(2);
        expect(needsReviewTotal).toBe(2);
      });

      it("failed counts a human fail and ignores a failure a human overruled", async () => {
        const { runs, q } = await seed();

        const { rows, total } = await queries.listRunsPage({
          q,
          evaluation: "failed",
          limit: 50,
          offset: 0,
        });

        expect(idsOf(rows)).toEqual(
          idsOf([runs.failed, runs.passOverruled, runs.mixed]),
        );
        expect(total).toBe(3);
      });

      it("not_evaluated keeps runs with a transcript and no verdicts", async () => {
        const { runs, q } = await seed();

        const { rows, total } = await queries.listRunsPage({
          q,
          evaluation: "not_evaluated",
          limit: 50,
          offset: 0,
        });

        expect(idsOf(rows)).toEqual(idsOf([runs.gap]));
        expect(total).toBe(1);
      });

      it("paginates within the filter and keeps the review-queue count independent of it", async () => {
        const { runs, q } = await seed();
        const page = (offset: number) =>
          queries.listRunsPage({
            q,
            evaluation: "failed",
            limit: 2,
            offset,
          });

        const [first, second] = await Promise.all([page(0), page(2)]);

        expect(first.rows).toHaveLength(2);
        expect(second.rows).toHaveLength(1);
        expect(first.total).toBe(3);
        expect(second.total).toBe(3);
        expect(idsOf([...first.rows, ...second.rows])).toEqual(
          idsOf([runs.failed, runs.passOverruled, runs.mixed]),
        );
        expect(first.needsReviewTotal).toBe(2);
      });

      it("counts only verdicts of active criteria under their current wording", async () => {
        const agent = await makeAgent("countrules agent");
        const active = await makeCriterion(agent.id, "Active?");
        const retired = await makeCriterion(agent.id, "Retired?", {
          isActive: false,
        });
        const reworded = await makeCriterion(agent.id, "New wording?");
        const onlyRetired = await makeRun(agent.id);
        const onlyOldWording = await makeRun(agent.id);
        const mixed = await makeRun(agent.id);
        const unjudged = await makeRun(agent.id);
        await addVerdict(onlyRetired.id, retired, "needs_review");
        await addVerdict(onlyOldWording.id, reworded, "fail", {
          questionSnapshot: "Old wording?",
        });
        await addVerdict(mixed.id, active, "pass");
        await addVerdict(mixed.id, retired, "fail");
        await addVerdict(mixed.id, reworded, "needs_review", {
          questionSnapshot: "Old wording?",
        });
        await addVerdict(unjudged.id, active, "error", { error: "boom" });
        await addVerdict(unjudged.id, reworded, "skipped", {
          skipReason: "too_long",
        });

        const all = await queries.listRunsPage({
          q: "countrules",
          limit: 50,
          offset: 0,
        });
        const [queue, failed] = await Promise.all(
          (["needs_review", "failed"] as const).map((evaluation) =>
            queries.listRunsPage({
              q: "countrules",
              evaluation,
              limit: 50,
              offset: 0,
            }),
          ),
        );
        const summary = (run: { id: string }) => {
          const row = all.rows.find((candidate) => candidate.id === run.id);
          return (
            row && {
              total: row.evaluationTotal,
              failed: row.evaluationFailed,
              needsReview: row.evaluationNeedsReview,
              passed: row.evaluationPassed,
              errors: row.evaluationErrors,
              skipped: row.evaluationSkipped,
            }
          );
        };

        expect(queue.rows).toEqual([]);
        expect(queue.needsReviewTotal).toBe(0);
        expect(failed.rows).toEqual([]);
        expect(summary(onlyRetired)).toMatchObject({ total: 0 });
        expect(summary(onlyOldWording)).toMatchObject({ total: 0, failed: 0 });
        expect(summary(mixed)).toEqual({
          total: 1,
          failed: 0,
          needsReview: 0,
          passed: 1,
          errors: 0,
          skipped: 0,
        });
        expect(summary(unjudged)).toEqual({
          total: 2,
          failed: 0,
          needsReview: 0,
          passed: 0,
          errors: 1,
          skipped: 1,
        });
      });

      it("not_evaluated only lists runs of agents that currently have an active criterion", async () => {
        const withCriterion = await makeAgent("gapcheck covered agent");
        const retiredOnly = await makeAgent("gapcheck retired agent");
        const noCriteria = await makeAgent("gapcheck bare agent");
        await makeCriterion(withCriterion.id, "Active?");
        await makeCriterion(retiredOnly.id, "Retired?", { isActive: false });
        const covered = await makeRun(withCriterion.id);
        const retired = await makeRun(retiredOnly.id);
        const bare = await makeRun(noCriteria.id);
        await Promise.all(
          [covered, retired, bare].map((run) => addTranscript(run.id)),
        );

        const { rows } = await queries.listRunsPage({
          q: "gapcheck",
          evaluation: "not_evaluated",
          limit: 50,
          offset: 0,
        });

        expect(idsOf(rows)).toEqual(idsOf([covered]));
      });

      it("not_evaluated includes a run whose only verdicts no longer count", async () => {
        const agent = await makeAgent("gapstale agent");
        const criterion = await makeCriterion(agent.id, "Now worded so?");
        const run = await makeRun(agent.id);
        await addTranscript(run.id);
        await addVerdict(run.id, criterion, "pass", {
          questionSnapshot: "Worded before?",
        });

        const { rows } = await queries.listRunsPage({
          q: "gapstale",
          evaluation: "not_evaluated",
          limit: 50,
          offset: 0,
        });

        expect(idsOf(rows)).toEqual(idsOf([run]));
      });

      it("combines with the source filter", async () => {
        const { runs, q } = await seed();

        const { rows, needsReviewTotal } = await queries.listRunsPage({
          q,
          source: "v1",
          evaluation: "failed",
          limit: 50,
          offset: 0,
        });

        expect(idsOf(rows)).toEqual(idsOf([runs.mixed]));
        expect(needsReviewTotal).toBe(1);
      });
    });
  });
});
