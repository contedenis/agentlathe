import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const migrationsFolder = fileURLToPath(
  new URL("../../../db/drizzle", import.meta.url),
);

let container: StartedPostgreSqlContainer;
let pool: Pool;
let dbModule: typeof import("@agentlathe/db");
let resolveAgentVersion: typeof import("../../src/versions").resolveAgentVersion;
let createRunRecorder: typeof import("../../src/recording").createRunRecorder;

describe("resolveAgentVersion (requires Docker)", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").start();
    process.env.DATABASE_URL = container.getConnectionUri();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await migrate(drizzle(pool), { migrationsFolder });

    dbModule = await import("@agentlathe/db");
    ({ resolveAgentVersion } = await import("../../src/versions"));
    ({ createRunRecorder } = await import("../../src/recording"));
  }, 60000);

  afterAll(async () => {
    await dbModule?.closePool();
    await pool?.end();
    await container?.stop();
  });

  async function makeAgent(name: string) {
    const { db, agents, agentSlug } = dbModule;
    const [agent] = await db
      .insert(agents)
      .values({ name, slug: agentSlug(name), model: "test/model" })
      .returning();
    return agent;
  }

  async function makeSkill(name: string, content: string) {
    const { db, skills } = dbModule;
    const [skill] = await db
      .insert(skills)
      .values({ name, description: `${name} skill`, content })
      .returning();
    return skill;
  }

  async function linkSkill(agentId: string, skillId: string) {
    const { db, agentSkills } = dbModule;
    await db.insert(agentSkills).values({ agentId, skillId });
  }

  async function linkChild(parentId: string, childId: string) {
    const { db, agentSubAgents } = dbModule;
    await db.insert(agentSubAgents).values({ parentId, childId });
  }

  async function versionRows(agentId: string) {
    const { db, agentVersions } = dbModule;
    return db
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.agentId, agentId));
  }

  it("the same config resolves to the same version, stored once", async () => {
    const agent = await makeAgent("stable agent");
    const skill = await makeSkill("stable", "Say hi.");
    await linkSkill(agent.id, skill.id);

    const [first, second] = await Promise.all([
      resolveAgentVersion(agent.id),
      resolveAgentVersion(agent.id),
    ]);
    const third = await resolveAgentVersion(agent.id);

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(await versionRows(agent.id)).toHaveLength(1);
  });

  it("editing a skill shared by two agents gives both a new version", async () => {
    const { db, skills } = dbModule;
    const [a, b] = await Promise.all([
      makeAgent("shared a"),
      makeAgent("shared b"),
    ]);
    const skill = await makeSkill("shared", "Version one.");
    await Promise.all([linkSkill(a.id, skill.id), linkSkill(b.id, skill.id)]);
    const [beforeA, beforeB] = await Promise.all([
      resolveAgentVersion(a.id),
      resolveAgentVersion(b.id),
    ]);

    await db
      .update(skills)
      .set({ content: "Version two." })
      .where(eq(skills.id, skill.id));
    const [afterA, afterB] = await Promise.all([
      resolveAgentVersion(a.id),
      resolveAgentVersion(b.id),
    ]);

    expect(afterA).not.toBe(beforeA);
    expect(afterB).not.toBe(beforeB);
  });

  it("editing a child agent gives its parent a new version", async () => {
    const { db, agents } = dbModule;
    const parent = await makeAgent("versioned parent");
    const child = await makeAgent("versioned child");
    await linkChild(parent.id, child.id);
    const before = await resolveAgentVersion(parent.id);

    await db
      .update(agents)
      .set({ systemPrompt: "Answer in French." })
      .where(eq(agents.id, child.id));

    expect(await resolveAgentVersion(parent.id)).not.toBe(before);
  });

  it("a parent-child cycle terminates and stays deterministic", async () => {
    const a = await makeAgent("cycle a");
    const b = await makeAgent("cycle b");
    await Promise.all([linkChild(a.id, b.id), linkChild(b.id, a.id)]);

    const first = await resolveAgentVersion(a.id);
    expect(await resolveAgentVersion(a.id)).toBe(first);
    expect(await resolveAgentVersion(b.id)).toEqual(expect.any(String));
  });

  it("never stores an MCP server's auth config or URL credentials", async () => {
    const { db, mcpServers, agentMcpTools } = dbModule;
    const agent = await makeAgent("mcp agent");
    const [server] = await db
      .insert(mcpServers)
      .values({
        name: "Secret server",
        serverUrl: "http://localhost:9/mcp?token=literal-url-secret",
        authConfig: { Authorization: "Bearer literal-secret-value" },
      })
      .returning();
    await db
      .insert(agentMcpTools)
      .values({ agentId: agent.id, serverId: server.id, toolName: "search" });

    await resolveAgentVersion(agent.id);

    const [row] = await versionRows(agent.id);
    const stored = JSON.stringify(row.snapshot);
    expect(stored).not.toContain("literal-secret-value");
    expect(stored).not.toContain("literal-url-secret");
  });

  it("a run recorded through the recorder carries its agent version", async () => {
    const { db, agentRuns, setSettings } = dbModule;
    await setSettings({ trackV1Runs: true });
    const agent = await makeAgent("recorded agent");

    const recorder = createRunRecorder({ agent, source: "v1" });
    const runId = await recorder.record({});

    const [run] = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, runId as string));
    expect(run.agentVersionId).toBe(await resolveAgentVersion(agent.id));
  });

  it("an untracked source resolves no version and stores none", async () => {
    const { setSettings } = dbModule;
    await setSettings({ trackMcpRuns: false });
    const agent = await makeAgent("untracked agent");

    const recorder = createRunRecorder({ agent, source: "mcp" });
    const runId = await recorder.record({});

    expect(runId).toBeNull();
    expect(await versionRows(agent.id)).toHaveLength(0);
  });

  it("a failed version resolution still records the run, without a version", async () => {
    const { db, agentRuns, setSettings } = dbModule;
    await setSettings({ trackV1Runs: true });
    const agent = await makeAgent("unversioned agent");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await pool.query("ALTER TABLE agent_versions RENAME TO agent_versions_off");
    let runId: string | null;
    try {
      const recorder = createRunRecorder({ agent, source: "v1" });
      runId = await recorder.record({});
    } finally {
      await pool.query(
        "ALTER TABLE agent_versions_off RENAME TO agent_versions",
      );
      consoleError.mockRestore();
    }

    expect(runId).not.toBeNull();
    const [run] = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, runId as string));
    expect(run.agentVersionId).toBeNull();
  });
});
