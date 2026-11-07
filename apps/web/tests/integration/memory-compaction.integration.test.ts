import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
let provider: Server;
let dbModule: typeof import("@agentlathe/db");
let compaction: typeof import("../../lib/memory-compaction");
let after: typeof import("next/server").after;
let answers: unknown[];
let storeId: string;

const KEY = "partition";

const reply = (content: string) => ({
  id: "gen",
  object: "chat.completion",
  created: 1,
  model: "test/model",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
});

const merged = {
  operations: [
    {
      op: "merge",
      ids: ["c1", "c2"],
      content: "Refunds over $500 go to billing; ask for the order id.",
    },
  ],
};

async function entries() {
  const { entries } = await dbModule.readPartition(storeId, KEY);
  return entries.map((entry) => `${entry.shortId}: ${entry.content}`);
}

async function entryId(shortId: string) {
  const { and, eq } = await import("drizzle-orm");
  const [row] = await dbModule.db
    .select({ id: dbModule.memoryEntries.id })
    .from(dbModule.memoryEntries)
    .where(
      and(
        eq(dbModule.memoryEntries.storeId, storeId),
        eq(dbModule.memoryEntries.shortId, shortId),
      ),
    );
  return row?.id;
}

async function compactions() {
  const { eq } = await import("drizzle-orm");
  return dbModule.db
    .select()
    .from(dbModule.memoryCompactions)
    .where(eq(dbModule.memoryCompactions.storeId, storeId));
}

describe("memory compaction (requires Docker)", () => {
  beforeAll(async () => {
    provider = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const next = answers.shift();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply(JSON.stringify(next ?? {}))));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, resolve));
    process.env.PROVIDER_BASE_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    process.env.PROVIDER_API_KEY = "test-key";

    container = await new PostgreSqlContainer("postgres:16").start();
    process.env.DATABASE_URL = container.getConnectionUri();
    dbModule = await import("@agentlathe/db");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(drizzle(dbModule.getPool()), { migrationsFolder });
    compaction = await import("../../lib/memory-compaction");
    ({ after } = await import("next/server"));
  }, 60000);

  afterAll(async () => {
    await dbModule.closePool();
    await container.stop();
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      provider.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(async () => {
    vi.mocked(after).mockClear();
    answers = [];
    await dbModule.db.delete(dbModule.memoryStores);
    await dbModule.db.delete(dbModule.agents);
    const [agent] = await dbModule.db
      .insert(dbModule.agents)
      .values({ name: "support", slug: "support", model: "test/model" })
      .returning();
    const [store] = await dbModule.db
      .insert(dbModule.memoryStores)
      .values({
        name: "Lessons",
        scope: "custom",
        ownerAgentId: agent.id,
        memoryKey: KEY,
        purpose: "Support lessons.",
        charLimit: 1000,
      })
      .returning();
    storeId = store.id;
    await dbModule.applyMemoryOps(
      storeId,
      KEY,
      [
        {
          op: "add",
          content: `Refunds over $500 go to billing. ${"r".repeat(420)}`,
        },
        {
          op: "add",
          content: `Ask for the order id first. ${"o".repeat(440)}`,
        },
      ],
      { author: "human" },
    );
  });

  it("compacts a memory past 90% after a write with the agent's model, keeping what it replaced restorable", async () => {
    answers = [merged];

    compaction.scheduleCompaction([{ storeId, partitionKey: KEY }]);
    await vi.mocked(after).mock.calls[0][0];

    expect(await entries()).toEqual([
      "c1: Refunds over $500 go to billing; ask for the order id.",
    ]);
    const [row] = await compactions();
    expect(row).toMatchObject({
      status: "applied",
      model: "test/model",
      fromRevision: 1,
      toRevision: 2,
      inputTokens: 50,
      outputTokens: 10,
      operations: { beforeChars: 921, afterChars: 54 },
    });
    const history = await dbModule.db
      .select()
      .from(dbModule.memoryEntryVersions)
      .where(
        (await import("drizzle-orm")).eq(
          dbModule.memoryEntryVersions.revision,
          2,
        ),
      );
    expect(
      history.map((version) => [version.op, version.author]).sort(),
    ).toEqual([
      ["compaction", "compaction"],
      ["delete", "compaction"],
    ]);

    const original = (
      await dbModule.listMemoryEntryVersions((await entryId("c2")) as string)
    ).at(-1);
    await dbModule.applyMemoryOps(
      storeId,
      KEY,
      [{ op: "restore", shortId: "c2", versionId: original?.id as string }],
      { author: "human" },
    );
    expect((await entries()).map((entry) => entry.slice(0, 20))).toEqual([
      "c1: Refunds over $50",
      "c2: Ask for the orde",
    ]);
  });

  it("leaves a memory under 90% alone", async () => {
    await dbModule.applyMemoryOps(
      storeId,
      KEY,
      [{ op: "delete", shortId: "c2" }],
      { author: "human" },
    );

    expect(await compaction.compactPartition(storeId, KEY)).toEqual({
      status: "skipped",
      reason: "The memory is not full enough.",
    });
  });

  it("does not call the model when pinned entries alone exceed what compaction keeps", async () => {
    await Promise.all(
      ["c1", "c2"].map(async (shortId) =>
        dbModule.setMemoryEntryPinned(
          storeId,
          (await entryId(shortId)) as string,
          true,
        ),
      ),
    );
    answers = [merged];

    expect(await compaction.compactPartition(storeId, KEY)).toEqual({
      status: "skipped",
      reason: "Pinned entries alone take more than compaction can keep.",
    });
    expect(answers).toHaveLength(1);
    expect(await compactions()).toEqual([]);
  });

  it("gives up after two bad answers without touching the memory", async () => {
    answers = [{ operations: [] }, { operations: [{ op: "keep", id: "c1" }] }];

    const outcome = await compaction.compactPartition(storeId, KEY);

    expect(outcome.status).toBe("failed");
    expect(await entries()).toHaveLength(2);
    const [row] = await compactions();
    expect(row.error).toMatch(/^The compaction failed twice: /);
    expect(row).toMatchObject({ inputTokens: 100, outputTokens: 20 });
  });
});
