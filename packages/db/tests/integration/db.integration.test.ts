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

  describe("schedules and their occurrences", () => {
    async function makeSchedule(agentName: string) {
      const [agent] = await db
        .insert(schema.agents)
        .values({
          name: agentName,
          slug: agentSlug(agentName),
          model: "test/model",
        })
        .returning();
      const [schedule] = await db
        .insert(schema.schedules)
        .values({
          agentId: agent.id,
          name: "Daily digest",
          frequency: "daily",
          timeOfDay: "09:00",
          timezone: "Europe/Madrid",
          input: "Summarize yesterday.",
        })
        .returning();
      return { agent, schedule };
    }

    const nominalAt = new Date("2026-10-19T07:00:00Z");

    it("deleting the agent removes its schedules and their occurrences", async () => {
      const { agent, schedule } = await makeSchedule("Schedule cascade agent");
      await db
        .insert(schema.scheduleOccurrences)
        .values({ scheduleId: schedule.id, nominalAt, status: "succeeded" });

      await db.delete(schema.agents).where(eq(schema.agents.id, agent.id));

      expect(
        await db
          .select()
          .from(schema.scheduleOccurrences)
          .where(eq(schema.scheduleOccurrences.scheduleId, schedule.id)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(schema.schedules)
          .where(eq(schema.schedules.id, schedule.id)),
      ).toHaveLength(0);
    });

    it("deleting a schedule keeps its runs, and deleting a run keeps its occurrence", async () => {
      const { agent, schedule } = await makeSchedule("Schedule runs agent");
      const [run] = await db
        .insert(schema.agentRuns)
        .values({
          agentId: agent.id,
          source: "schedule",
          scheduleId: schedule.id,
          durationMs: 5,
        })
        .returning();
      const [other] = await db
        .insert(schema.schedules)
        .values({ ...schedule, id: undefined, name: "Other" })
        .returning();
      const [occurrence] = await db
        .insert(schema.scheduleOccurrences)
        .values({
          scheduleId: other.id,
          nominalAt,
          status: "succeeded",
          runId: run.id,
        })
        .returning();

      await db
        .delete(schema.schedules)
        .where(eq(schema.schedules.id, schedule.id));
      const [kept] = await db
        .select()
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.id, run.id));
      expect(kept.scheduleId).toBeNull();

      await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
      const [orphan] = await db
        .select()
        .from(schema.scheduleOccurrences)
        .where(eq(schema.scheduleOccurrences.id, occurrence.id));
      expect(orphan.runId).toBeNull();
    });

    it("allows one occurrence per schedule and nominal time", async () => {
      const { schedule } = await makeSchedule("Occurrence uniqueness agent");
      await db
        .insert(schema.scheduleOccurrences)
        .values({ scheduleId: schedule.id, nominalAt, status: "running" });

      await expect(
        db
          .insert(schema.scheduleOccurrences)
          .values({ scheduleId: schedule.id, nominalAt, status: "running" }),
      ).rejects.toMatchObject({ cause: { code: "23505" } });
    });

    it("rejects a trigger the presets cannot express", async () => {
      const { schedule } = await makeSchedule("Schedule constraint agent");
      const base = { ...schedule, id: undefined };
      const invalid = [
        { frequency: "every_minute" },
        { timeOfDay: "9:00" },
        { timeOfDay: "24:00" },
        { frequency: "weekly", weekday: null },
        { frequency: "daily", weekday: 1 },
        { frequency: "weekly", weekday: 7 },
        { frequency: "monthly", startDate: null },
        { consecutiveFailures: -1 },
      ];

      for (const values of invalid) {
        await expect(
          db.insert(schema.schedules).values({ ...base, ...values }),
        ).rejects.toMatchObject({ cause: { code: "23514" } });
      }
      await expect(
        db.insert(schema.schedules).values({
          ...base,
          frequency: "monthly",
          startDate: "2026-01-31",
        }),
      ).resolves.toBeDefined();
      await expect(
        db
          .insert(schema.scheduleOccurrences)
          .values({ scheduleId: schedule.id, nominalAt, status: "queued" }),
      ).rejects.toMatchObject({ cause: { code: "23514" } });
    });
  });

  describe("memory stores", () => {
    async function makeEntry(name: string) {
      const [agent] = await db
        .insert(schema.agents)
        .values({ name, slug: agentSlug(name), model: "test/model" })
        .returning();
      const [store] = await db
        .insert(schema.memoryStores)
        .values({
          name,
          scope: "agent",
          ownerAgentId: agent.id,
          purpose: "Facts about the job.",
        })
        .returning();
      await db
        .insert(schema.memoryPartitions)
        .values({ storeId: store.id, partitionKey: agent.id, revision: 1 });
      const [entry] = await db
        .insert(schema.memoryEntries)
        .values({ storeId: store.id, partitionKey: agent.id, shortId: "a1" })
        .returning();
      const [run] = await db
        .insert(schema.agentRuns)
        .values({ agentId: agent.id, source: "v1", durationMs: 5 })
        .returning();
      await db.insert(schema.memoryEntryVersions).values({
        entryId: entry.id,
        revision: 1,
        op: "add",
        content: "The report goes out on Mondays.",
        runId: run.id,
        author: "agent",
      });
      return { agent, store, entry, run };
    }

    it("deleting an agent deletes its memory and everything in it", async () => {
      const { agent, store, entry } = await makeEntry("Memory owner agent");

      await db.delete(schema.agents).where(eq(schema.agents.id, agent.id));

      expect(
        await db
          .select()
          .from(schema.memoryStores)
          .where(eq(schema.memoryStores.id, store.id)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(schema.memoryEntries)
          .where(eq(schema.memoryEntries.id, entry.id)),
      ).toHaveLength(0);
    });

    it("deleting a run keeps the memory it wrote, without the link", async () => {
      const { entry, run } = await makeEntry("Memory run agent");

      await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));

      const [version] = await db
        .select()
        .from(schema.memoryEntryVersions)
        .where(eq(schema.memoryEntryVersions.entryId, entry.id));
      expect(version.content).toBe("The report goes out on Mondays.");
      expect(version.runId).toBeNull();
    });

    it("deleting a store removes its partitions, entries, history, proposals and compactions", async () => {
      const { store, entry, agent } = await makeEntry("Memory cascade agent");
      await db.insert(schema.memoryProposals).values({
        storeId: store.id,
        partitionKey: agent.id,
        op: "delete",
        entryId: entry.id,
        baseRevision: 1,
      });
      await db.insert(schema.memoryCompactions).values({
        storeId: store.id,
        partitionKey: agent.id,
        fromRevision: 1,
        model: "test/model",
        status: "running",
      });

      await db
        .delete(schema.memoryStores)
        .where(eq(schema.memoryStores.id, store.id));

      for (const [table, column] of [
        [schema.memoryPartitions, schema.memoryPartitions.storeId],
        [schema.memoryEntries, schema.memoryEntries.storeId],
        [schema.memoryProposals, schema.memoryProposals.storeId],
        [schema.memoryCompactions, schema.memoryCompactions.storeId],
      ] as const)
        expect(
          await db.select().from(table).where(eq(column, store.id)),
        ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(schema.memoryEntryVersions)
          .where(eq(schema.memoryEntryVersions.entryId, entry.id)),
      ).toHaveLength(0);
    });

    it("rejects what the memory model cannot hold", async () => {
      const { store, entry, agent } = await makeEntry(
        "Memory constraint agent",
      );
      const base = {
        name: "x",
        scope: "custom",
        memoryKey: "team",
        ownerAgentId: agent.id,
        purpose: "x",
      };

      for (const values of [
        { ...base, scope: "global" },
        { ...base, scope: "subject" },
        { ...base, charLimit: 20001 },
        { ...base, charLimit: 0 },
        { ...base, memoryKey: null },
        { ...base, scope: "agent_subject" },
      ])
        await expect(
          db.insert(schema.memoryStores).values(values),
        ).rejects.toMatchObject({ cause: { code: "23514" } });
      for (const values of [
        { op: "merge", author: "agent" },
        { op: "add", author: "system" },
      ])
        await expect(
          db
            .insert(schema.memoryEntryVersions)
            .values({ entryId: entry.id, revision: 2, ...values }),
        ).rejects.toMatchObject({ cause: { code: "23514" } });
      await expect(
        db
          .insert(schema.memoryEntries)
          .values({ storeId: store.id, partitionKey: agent.id, shortId: "a1" }),
      ).rejects.toMatchObject({ cause: { code: "23505" } });
      await expect(
        db
          .insert(schema.memoryStores)
          .values({ ...base, scope: "agent", memoryKey: null }),
      ).rejects.toMatchObject({ cause: { code: "23505" } });
      await expect(
        db
          .insert(schema.memoryEntries)
          .values({ storeId: store.id, partitionKey: "nobody", shortId: "a1" }),
      ).rejects.toMatchObject({ cause: { code: "23503" } });
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

    it("adds example memories and paused schedules, once, to a demo that predates them", async () => {
      const { seedDemo } = await import("../../src/seed-demo");
      await seedDemo();

      const demoStores = async () =>
        (
          await db
            .select({
              id: schema.memoryStores.id,
              name: schema.memoryStores.name,
              owner: schema.agents.name,
            })
            .from(schema.memoryStores)
            .leftJoin(
              schema.agents,
              eq(schema.agents.id, schema.memoryStores.ownerAgentId),
            )
        ).filter((row) =>
          [
            "Support coordinator",
            "Repository analyst",
            "Data assistant",
          ].includes(row.owner ?? ""),
        );
      const stores = await demoStores();
      expect(
        stores.map((row) => `${row.owner ?? "shared"}: ${row.name}`).sort(),
      ).toEqual([
        "Data assistant: Agent memory with a custom key",
        "Repository analyst: Agent memory",
        "Support coordinator: Agent memory per subject",
      ]);
      const partitions = await db
        .select({
          key: schema.memoryPartitions.partitionKey,
          chars: schema.memoryPartitions.chars,
        })
        .from(schema.memoryPartitions)
        .where(
          inArray(
            schema.memoryPartitions.storeId,
            stores.map((row) => row.id),
          ),
        );
      expect(partitions.map((row) => row.key).sort()).toEqual(
        expect.arrayContaining(["customer-123", "customer-456", "payments"]),
      );
      expect(partitions).toHaveLength(3);

      const seeded = await db.select().from(schema.schedules);
      expect(
        seeded.map((row) => [row.name, row.isActive, row.nextRunAt]),
      ).toEqual(
        expect.arrayContaining([
          ["Weekly metrics digest", false, null],
          ["Follow-up with customer-123", false, null],
        ]),
      );
      expect(
        seeded.find((row) => row.name === "Follow-up with customer-123")
          ?.subjectId,
      ).toBe("customer-123");

      await seedDemo();
      expect(await demoStores()).toHaveLength(3);
      expect(await db.select().from(schema.schedules)).toHaveLength(
        seeded.length,
      );
    });
  });
});
