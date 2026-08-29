import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
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
});
