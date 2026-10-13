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
import { agentSlug } from "../../src/naming";
import * as schema from "../../src/schema";

const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

describe("db integration (requires Docker)", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").start();
    process.env.DATABASE_URL = container.getConnectionUri();

    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });

    await migrate(drizzle(pool), { migrationsFolder });
  }, 60000);

  afterAll(async () => {
    // seed() opens its own Pool through client.ts: it must be closed or container.stop() breaks vitest.
    const { closePool } = await import("../../src/client");
    await closePool();
    await pool.end();
    await container.stop();
  });

  describe("cascade deletes", () => {
    it("removes rows from every join table and the agent runs when the agent is deleted", async () => {
      const [[parent], [child], [skill], [tool], [server]] = await Promise.all([
        db
          .insert(schema.agents)
          .values({
            name: "Cascade parent",
            slug: agentSlug("Cascade parent"),
            model: "test/model",
          })
          .returning(),
        db
          .insert(schema.agents)
          .values({
            name: "Cascade child",
            slug: agentSlug("Cascade child"),
            model: "test/model",
          })
          .returning(),
        db
          .insert(schema.skills)
          .values({ name: "Cascade skill", description: "d", content: "c" })
          .returning(),
        db
          .insert(schema.tools)
          .values({
            name: "Cascade tool",
            description: "d",
            endpoint: "https://example.com",
            inputSchema: { type: "object", properties: {} },
          })
          .returning(),
        db
          .insert(schema.mcpServers)
          .values({
            name: "Cascade server",
            serverUrl: "https://example.com/mcp",
          })
          .returning(),
      ]);

      await Promise.all([
        db
          .insert(schema.agentSkills)
          .values({ agentId: parent.id, skillId: skill.id }),
        db
          .insert(schema.agentTools)
          .values({ agentId: parent.id, toolId: tool.id }),
        db
          .insert(schema.agentSubAgents)
          .values({ parentId: parent.id, childId: child.id }),
        db.insert(schema.agentMcpTools).values({
          agentId: parent.id,
          serverId: server.id,
          toolName: "some_tool",
        }),
        db
          .insert(schema.agentRuns)
          .values({ agentId: parent.id, source: "dashboard", durationMs: 1 }),
      ]);

      await db.delete(schema.agents).where(eq(schema.agents.id, parent.id));

      const [
        agentSkillsLeft,
        agentToolsLeft,
        agentSubAgentsLeft,
        agentMcpToolsLeft,
        runsLeft,
      ] = await Promise.all([
        db
          .select()
          .from(schema.agentSkills)
          .where(eq(schema.agentSkills.agentId, parent.id)),
        db
          .select()
          .from(schema.agentTools)
          .where(eq(schema.agentTools.agentId, parent.id)),
        db
          .select()
          .from(schema.agentSubAgents)
          .where(eq(schema.agentSubAgents.parentId, parent.id)),
        db
          .select()
          .from(schema.agentMcpTools)
          .where(eq(schema.agentMcpTools.agentId, parent.id)),
        db
          .select()
          .from(schema.agentRuns)
          .where(eq(schema.agentRuns.agentId, parent.id)),
      ]);

      expect(agentSkillsLeft).toHaveLength(0);
      expect(agentToolsLeft).toHaveLength(0);
      expect(agentSubAgentsLeft).toHaveLength(0);
      expect(agentMcpToolsLeft).toHaveLength(0);
      expect(runsLeft).toHaveLength(0);

      const remainingChild = await db.query.agents.findFirst({
        where: eq(schema.agents.id, child.id),
      });
      expect(remainingChild).toBeDefined();
    });
  });

  describe("agent_sub_agents CHECK constraint", () => {
    it("rejects a row where parent_id equals child_id", async () => {
      const [agent] = await db
        .insert(schema.agents)
        .values({
          name: "Self-reference agent",
          slug: agentSlug("Self-reference agent"),
          model: "test/model",
        })
        .returning();

      await expect(
        db
          .insert(schema.agentSubAgents)
          .values({ parentId: agent.id, childId: agent.id }),
      ).rejects.toThrow();
    });
  });

  describe("agents.name UNIQUE constraint", () => {
    it("rejects a second agent with the same name with a 23505", async () => {
      await db.insert(schema.agents).values({
        name: "Duplicate name agent",
        slug: agentSlug("Duplicate name agent"),
        model: "test/model",
      });

      await expect(
        db.insert(schema.agents).values({
          name: "Duplicate name agent",
          slug: agentSlug("Duplicate name agent"),
          model: "test/model",
        }),
      ).rejects.toMatchObject({ cause: { code: "23505" } });
    });
  });

  describe("inverse cascade deletes", () => {
    it("removes the join row when the skill/tool/mcp server side is deleted", async () => {
      const [[agent], [skill], [tool], [server]] = await Promise.all([
        db
          .insert(schema.agents)
          .values({
            name: "Inverse cascade agent",
            slug: agentSlug("Inverse cascade agent"),
            model: "test/model",
          })
          .returning(),
        db
          .insert(schema.skills)
          .values({
            name: "Inverse cascade skill",
            description: "d",
            content: "c",
          })
          .returning(),
        db
          .insert(schema.tools)
          .values({
            name: "Inverse cascade tool",
            description: "d",
            endpoint: "https://example.com",
            inputSchema: { type: "object", properties: {} },
          })
          .returning(),
        db
          .insert(schema.mcpServers)
          .values({
            name: "Inverse cascade server",
            serverUrl: "https://example.com/mcp",
          })
          .returning(),
      ]);

      await Promise.all([
        db
          .insert(schema.agentSkills)
          .values({ agentId: agent.id, skillId: skill.id }),
        db
          .insert(schema.agentTools)
          .values({ agentId: agent.id, toolId: tool.id }),
        db.insert(schema.agentMcpTools).values({
          agentId: agent.id,
          serverId: server.id,
          toolName: "some_tool",
        }),
      ]);

      await Promise.all([
        db.delete(schema.skills).where(eq(schema.skills.id, skill.id)),
        db.delete(schema.tools).where(eq(schema.tools.id, tool.id)),
        db.delete(schema.mcpServers).where(eq(schema.mcpServers.id, server.id)),
      ]);

      const [agentSkillsLeft, agentToolsLeft, agentMcpToolsLeft] =
        await Promise.all([
          db
            .select()
            .from(schema.agentSkills)
            .where(eq(schema.agentSkills.agentId, agent.id)),
          db
            .select()
            .from(schema.agentTools)
            .where(eq(schema.agentTools.agentId, agent.id)),
          db
            .select()
            .from(schema.agentMcpTools)
            .where(eq(schema.agentMcpTools.agentId, agent.id)),
        ]);

      expect(agentSkillsLeft).toHaveLength(0);
      expect(agentToolsLeft).toHaveLength(0);
      expect(agentMcpToolsLeft).toHaveLength(0);

      const remainingAgent = await db.query.agents.findFirst({
        where: eq(schema.agents.id, agent.id),
      });
      expect(remainingAgent).toBeDefined();
    });
  });

  describe("run transcripts and fix drafts", () => {
    async function makeRun(agentName: string) {
      const [agent] = await db
        .insert(schema.agents)
        .values({
          name: agentName,
          slug: agentSlug(agentName),
          model: "test/model",
        })
        .returning();
      const [run] = await db
        .insert(schema.agentRuns)
        .values({ agentId: agent.id, source: "v1", durationMs: 5 })
        .returning();
      return { agent, run };
    }

    it("deletes the transcript and the drafts when the run is deleted", async () => {
      const { run } = await makeRun("Transcript cascade agent");

      await Promise.all([
        db.insert(schema.runTranscripts).values({
          runId: run.id,
          input: [{ role: "user", content: "hi" }],
          output: [{ role: "assistant", content: "hello" }],
        }),
        db.insert(schema.fixDrafts).values({
          runId: run.id,
          messageId: "msg-1",
          anchor: { type: "turn" },
          category: "prompt",
          rationale: "The tone is off",
        }),
      ]);

      await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));

      const [transcriptsLeft, draftsLeft] = await Promise.all([
        db
          .select()
          .from(schema.runTranscripts)
          .where(eq(schema.runTranscripts.runId, run.id)),
        db
          .select()
          .from(schema.fixDrafts)
          .where(eq(schema.fixDrafts.runId, run.id)),
      ]);
      expect(transcriptsLeft).toHaveLength(0);
      expect(draftsLeft).toHaveLength(0);
    });

    it("cascades from the agent down to the transcript", async () => {
      const { agent, run } = await makeRun("Transcript agent cascade");
      await db
        .insert(schema.runTranscripts)
        .values({ runId: run.id, input: [], output: [] });

      await db.delete(schema.agents).where(eq(schema.agents.id, agent.id));

      const transcriptsLeft = await db
        .select()
        .from(schema.runTranscripts)
        .where(eq(schema.runTranscripts.runId, run.id));
      expect(transcriptsLeft).toHaveLength(0);
    });

    it("rejects a draft with an unknown category or status", async () => {
      const { run } = await makeRun("Draft constraint agent");
      const base = {
        runId: run.id,
        messageId: "msg-1",
        anchor: { type: "turn" },
        rationale: "why",
      };

      await expect(
        db
          .insert(schema.fixDrafts)
          .values({ ...base, category: "not_a_category" }),
      ).rejects.toThrow();
      await expect(
        db
          .insert(schema.fixDrafts)
          .values({ ...base, category: "prompt", status: "not_a_status" }),
      ).rejects.toThrow();
    });

    it("allows one transcript per run at most", async () => {
      const { run } = await makeRun("Transcript uniqueness agent");
      await db
        .insert(schema.runTranscripts)
        .values({ runId: run.id, input: [], output: [] });

      await expect(
        db
          .insert(schema.runTranscripts)
          .values({ runId: run.id, input: [], output: [] }),
      ).rejects.toMatchObject({ cause: { code: "23505" } });
    });
  });

  describe("seed", () => {
    it("inserts the example agent linked to its skill and tool without violating constraints, and re-running it does not duplicate anything", async () => {
      const { seed } = await import("../../src/seed");
      await seed();
      await seed();

      const agentRows = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.name, "General assistant"));
      expect(agentRows).toHaveLength(1);
      const agent = agentRows[0];

      const [linkedSkills, linkedTools] = await Promise.all([
        db
          .select()
          .from(schema.agentSkills)
          .where(eq(schema.agentSkills.agentId, agent.id)),
        db
          .select()
          .from(schema.agentTools)
          .where(eq(schema.agentTools.agentId, agent.id)),
      ]);

      expect(linkedSkills).toHaveLength(1);
      expect(linkedTools).toHaveLength(1);
    });
  });

  describe("seed-demo collisions", () => {
    it("aborts with a message listing the colliding agent instead of a raw constraint error", async () => {
      await db.insert(schema.agents).values({
        name: "Data assistant",
        slug: agentSlug("Data assistant"),
        model: "test/model",
      });

      const { seedDemo } = await import("../../src/seed-demo");
      await expect(seedDemo()).rejects.toThrow(/Data assistant/);

      const markerRows = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.name, "General orchestrator"));
      expect(markerRows).toHaveLength(0);
    });

    it("seeds the demo agents with their example criteria once the collision is gone", async () => {
      await db
        .delete(schema.agents)
        .where(eq(schema.agents.name, "Data assistant"));

      const { seedDemo } = await import("../../src/seed-demo");
      await seedDemo();

      const criteria = await db
        .select({
          agent: schema.agents.name,
          appliesWhen: schema.agentCriteria.appliesWhen,
          passDescription: schema.agentCriteria.passDescription,
          failDescription: schema.agentCriteria.failDescription,
        })
        .from(schema.agentCriteria)
        .innerJoin(
          schema.agents,
          eq(schema.agents.id, schema.agentCriteria.agentId),
        );

      expect(criteria.map((row) => row.agent).sort()).toEqual([
        "Data assistant",
        "Support coordinator",
        "Support coordinator",
      ]);
      expect(
        criteria.every((row) => row.passDescription && row.failDescription),
      ).toBe(true);
      expect(criteria.filter((row) => row.appliesWhen)).toHaveLength(1);
    });
  });
});
