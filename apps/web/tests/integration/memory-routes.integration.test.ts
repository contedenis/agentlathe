import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("next/server", () => ({ after: vi.fn() }));

const migrationsFolder = fileURLToPath(
  new URL("../../../../packages/db/drizzle", import.meta.url),
);

let container: StartedPostgreSqlContainer;
let dbModule: typeof import("@agentlathe/db");
let entries: typeof import("../../app/api/memory-stores/[id]/entries/route");
let entry: typeof import("../../app/api/memory-stores/[id]/entries/[entryId]/route");
let restore: typeof import("../../app/api/memory-stores/[id]/entries/[entryId]/restore/route");
let versions: typeof import("../../app/api/memory-stores/[id]/entries/[entryId]/versions/route");
let proposal: typeof import("../../app/api/memory-stores/[id]/proposals/[proposalId]/route");
let agentsRoute: typeof import("../../app/api/agents/route");
let agentRoute: typeof import("../../app/api/agents/[id]/route");
let queries: typeof import("../../lib/queries-memory");
let forget: typeof import("../../app/api/subjects/forget/route");

const jsonRequest = (method: string, body?: unknown) =>
  new Request("http://localhost/api/memory-stores", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const params = <T extends Record<string, string>>(value: T) => ({
  params: Promise.resolve(value),
});

async function makeAgent(name: string) {
  const [row] = await dbModule.db
    .insert(dbModule.agents)
    .values({ name, slug: dbModule.agentSlug(name), model: "test/model" })
    .returning();
  return row;
}

describe("memory routes (requires Docker)", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer(
      "pgvector/pgvector:0.8.6-pg16-trixie",
    ).start();
    process.env.DATABASE_URL = container.getConnectionUri();

    dbModule = await import("@agentlathe/db");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(drizzle(dbModule.getPool()), { migrationsFolder });

    entries = await import("../../app/api/memory-stores/[id]/entries/route");
    entry = await import(
      "../../app/api/memory-stores/[id]/entries/[entryId]/route"
    );
    restore = await import(
      "../../app/api/memory-stores/[id]/entries/[entryId]/restore/route"
    );
    versions = await import(
      "../../app/api/memory-stores/[id]/entries/[entryId]/versions/route"
    );
    proposal = await import(
      "../../app/api/memory-stores/[id]/proposals/[proposalId]/route"
    );
    agentsRoute = await import("../../app/api/agents/route");
    agentRoute = await import("../../app/api/agents/[id]/route");
    queries = await import("../../lib/queries-memory");
    forget = await import("../../app/api/subjects/forget/route");
  }, 60000);

  afterAll(async () => {
    await dbModule.closePool();
    await container.stop();
  });

  beforeEach(async () => {
    await dbModule.db.delete(dbModule.memoryStores);
    await dbModule.db.delete(dbModule.agents);
  });

  const settings = (purpose = "What you learned.") => ({
    purpose,
    charLimit: 8000,
    requireApproval: false,
  });

  async function createAgent(name: string, memory?: unknown) {
    const res = await agentsRoute.POST(
      jsonRequest("POST", { name, model: "test/model", memory }),
    );
    return { res, body: await res.json() };
  }

  async function ownedStores(agentId: string) {
    const { eq } = await import("drizzle-orm");
    return dbModule.db
      .select()
      .from(dbModule.memoryStores)
      .where(eq(dbModule.memoryStores.ownerAgentId, agentId));
  }

  it("adds, edits, pins, deletes and restores entries, keeping their history", async () => {
    const { body: agent } = await createAgent("support", {
      type: "agent_subject",
      settings: settings("Your history with each customer."),
    });
    const [created] = await ownedStores(agent.id);
    const id = created.id;

    const missing = await entries.POST(
      jsonRequest("POST", { content: "Prefers Spanish." }),
      params({ id }),
    );
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toBe(
      "An entry in this store needs a subject.",
    );

    const added = await entries.POST(
      jsonRequest("POST", {
        subjectId: "user-42",
        content: "Prefers Spanish.",
      }),
      params({ id }),
    );
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({
      partitionKey: "user-42",
      revision: 1,
    });

    const {
      entries: [row],
    } = await queries.getPartitionEntries(id, "user-42");
    const target = params({ id, entryId: row.id });
    await entry.PATCH(
      jsonRequest("PATCH", { content: "Prefers English." }),
      target,
    );
    await entry.PATCH(jsonRequest("PATCH", { pinned: true }), target);
    expect((await entry.DELETE(jsonRequest("DELETE"), target)).status).toBe(
      204,
    );

    const afterDelete = await queries.getPartitionEntries(id, "user-42");
    expect(afterDelete.entries).toEqual([]);
    expect(afterDelete.deleted).toMatchObject([
      { shortId: "s1", content: "Prefers English." },
    ]);

    const history = await (
      await versions.GET(jsonRequest("GET"), target)
    ).json();
    expect(history.map((version: { op: string }) => version.op)).toEqual([
      "delete",
      "update",
      "add",
    ]);
    const original = history.find(
      (version: { op: string }) => version.op === "add",
    );
    const restored = await restore.POST(
      jsonRequest("POST", { versionId: original.id }),
      target,
    );
    expect(restored.status).toBe(200);
    expect(
      (await queries.getPartitionEntries(id, "user-42")).entries,
    ).toMatchObject([
      { shortId: "s1", content: "Prefers Spanish.", pinned: true },
    ]);

    const detail = await queries.getMemoryStore(id);
    expect(detail).toMatchObject({
      title: "support · Agent memory per subject",
      owner: { id: agent.id, name: "support" },
      partitions: [
        { partitionKey: "user-42", label: "user-42", revision: 4, entries: 1 },
      ],
    });
  });

  it("gives an agent one memory: switching keeps the other's content, and deleting the agent deletes them", async () => {
    const { res, body: agent } = await createAgent("ops", {
      type: "agent",
      settings: settings(),
    });
    expect(res.status).toBe(201);
    expect(await ownedStores(agent.id)).toMatchObject([
      {
        scope: "agent",
        name: "Agent memory",
        isActive: true,
      },
    ]);

    const patch = (memory: unknown) =>
      agentRoute.PATCH(
        jsonRequest("PATCH", { memory }),
        params({ id: agent.id }),
      );
    expect(
      (await patch({ type: "agent_subject", settings: settings() })).status,
    ).toBe(200);
    expect(
      (
        await patch({
          type: "custom",
          settings: settings("Team decisions."),
          memoryKey: " team-ops ",
        })
      ).status,
    ).toBe(200);
    expect(
      (await queries.listAgentMemoryStores(agent.id)).map((row) => [
        row.scope,
        row.isActive,
        row.memoryKey,
      ]),
    ).toEqual([
      ["agent", false, null],
      ["agent_subject", false, null],
      ["custom", true, "team-ops"],
    ]);
    expect((await patch({ type: "custom", settings: settings() })).status).toBe(
      400,
    );

    expect((await patch({ type: "none" })).status).toBe(200);
    expect(
      (await queries.listAgentMemoryStores(agent.id)).map(
        (row) => row.isActive,
      ),
    ).toEqual([false, false, false]);

    await agentRoute.DELETE(jsonRequest("DELETE"), params({ id: agent.id }));
    expect(await ownedStores(agent.id)).toEqual([]);
  });

  it("counts the runs of the last week that ran without their memory or read a collection by search, by message, leaving out other warnings", async () => {
    const agent = await makeAgent("warned agent");
    const warning = (code: string) => [{ code, message: code }];
    await dbModule.db.insert(dbModule.agentRuns).values([
      {
        agentId: agent.id,
        source: "v1",
        durationMs: 1,
        warnings: warning("memory_missing_subject"),
      },
      {
        agentId: agent.id,
        source: "v1",
        durationMs: 1,
        warnings: warning("memory_missing_subject"),
      },
      {
        agentId: agent.id,
        source: "v1",
        durationMs: 1,
        warnings: warning("memory_missing_key"),
      },
      {
        agentId: agent.id,
        source: "v1",
        durationMs: 1,
        warnings: warning("knowledge_too_large"),
      },
      { agentId: agent.id, source: "v1", durationMs: 1 },
      {
        agentId: agent.id,
        source: "v1",
        durationMs: 1,
        warnings: warning("memory_conflict"),
      },
      {
        agentId: agent.id,
        source: "v1",
        durationMs: 1,
        warnings: warning("memory_missing_subject"),
        createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      },
    ]);

    const counts = await queries.countRunWarnings(agent.id);

    expect(
      Object.fromEntries(counts.map((row) => [row.message, row.runs])),
    ).toEqual({
      memory_missing_subject: 2,
      memory_missing_key: 1,
      knowledge_too_large: 1,
    });
  });

  it("approves and rejects what the agent proposed to a store that needs approval", async () => {
    const { body: agent } = await createAgent("careful", {
      type: "custom",
      settings: { ...settings("Team decisions."), requireApproval: true },
      memoryKey: "team-ops",
    });
    const [created] = await ownedStores(agent.id);
    expect(created.requireApproval).toBe(true);
    const id = created.id;
    await dbModule.proposeMemoryOps(
      id,
      "team-ops",
      0,
      [
        { op: "add", content: "Deploys on Fridays." },
        { op: "add", content: "Lunch is at noon." },
      ],
      null,
    );
    const pending = await queries.getPartitionEntries(id, "team-ops");
    expect(pending.proposals).toHaveLength(2);
    const [first, second] = pending.proposals;

    const approved = await proposal.POST(
      jsonRequest("POST", { approve: true }),
      params({ id, proposalId: first.id }),
    );
    const rejected = await proposal.POST(
      jsonRequest("POST", { approve: false }),
      params({ id, proposalId: second.id }),
    );
    const again = await proposal.POST(
      jsonRequest("POST", { approve: true }),
      params({ id, proposalId: second.id }),
    );

    expect(await approved.json()).toEqual({ status: "approved", reason: null });
    expect(await rejected.json()).toEqual({ status: "rejected", reason: null });
    expect(again.status).toBe(404);
    const after = await queries.getPartitionEntries(id, "team-ops");
    expect(after.proposals).toEqual([]);
    expect(after.entries).toMatchObject([
      { shortId: "c1", content: "Deploys on Fridays." },
    ]);
    expect((await queries.getMemoryStore(id))?.partitions).toMatchObject([
      { partitionKey: "team-ops", pending: 0, entries: 1 },
    ]);
  });

  it("forgets a subject's memory and runs, and refuses a missing or overlong subject", async () => {
    const { body: agent } = await createAgent("support", {
      type: "agent_subject",
      settings: settings(),
    });
    const [store] = await ownedStores(agent.id);
    const add = await entries.POST(
      jsonRequest("POST", {
        subjectId: "customer-7",
        content: "Prefers email.",
      }),
      params({ id: store.id }),
    );
    expect(add.status).toBe(201);
    await dbModule.db.insert(dbModule.agentRuns).values({
      agentId: agent.id,
      source: "v1",
      durationMs: 1,
      subjectId: "customer-7",
    });

    for (const subjectId of [undefined, "  ", "x".repeat(201)])
      expect(
        (await forget.POST(jsonRequest("POST", { subjectId }))).status,
      ).toBe(400);

    const res = await forget.POST(
      jsonRequest("POST", { subjectId: " customer-7 " }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      memories: 1,
      runs: 1,
      transcripts: 0,
      schedules: 0,
    });
    expect((await queries.getMemoryStore(store.id))?.partitions).toEqual([]);
  });
});
