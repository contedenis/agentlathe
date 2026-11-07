import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../../src/schema";

const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let memory: typeof import("../../src/memory");

describe("memory writes and snapshots (requires Docker)", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer(
      "pgvector/pgvector:0.8.6-pg16-trixie",
    ).start();
    process.env.DATABASE_URL = container.getConnectionUri();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool, { schema });
    await migrate(drizzle(pool), { migrationsFolder });
    memory = await import("../../src/memory");
  }, 60000);

  afterAll(async () => {
    const { closePool } = await import("../../src/client");
    await closePool();
    await pool.end();
    await container.stop();
  });

  async function makeStore(
    scope: (typeof schema.memoryStores.$inferInsert)["scope"] = "agent",
    charLimit = 8000,
  ) {
    const [owner] = await db
      .insert(schema.agents)
      .values({
        name: `owner ${crypto.randomUUID()}`,
        slug: crypto.randomUUID(),
        model: "test/model",
      })
      .returning();
    const [store] = await db
      .insert(schema.memoryStores)
      .values({
        name: `store ${scope}`,
        scope,
        ownerAgentId: owner.id,
        memoryKey: scope === "custom" ? "team" : null,
        purpose: "Facts.",
        charLimit,
      })
      .returning();
    return store;
  }

  const contents = (entries: Array<{ shortId: string; content: string }>) =>
    entries.map((entry) => `${entry.shortId}: ${entry.content}`);

  it("versions every change and reads any past revision back", async () => {
    const store = await makeStore();
    const { applyMemoryOps, readPartition, readPartitionAt } = memory;

    const first = await applyMemoryOps(
      store.id,
      "agent-1",
      [
        { op: "add", content: "Refunds over $500 go to billing." },
        { op: "add", content: "  The archive API lives at /v2.  " },
      ],
      { author: "human" },
    );
    await applyMemoryOps(
      store.id,
      "agent-1",
      [
        {
          op: "update",
          shortId: "a1",
          content: "Refunds over $800 go to billing.",
        },
      ],
      { author: "human" },
    );
    const third = await applyMemoryOps(
      store.id,
      "agent-1",
      [{ op: "delete", shortId: "a2" }],
      { author: "human" },
    );

    expect(first).toEqual({ revision: 1, chars: 61, skipped: [] });
    expect(third.revision).toBe(3);
    expect(contents(await readPartitionAt(store.id, "agent-1", 1))).toEqual([
      "a1: Refunds over $500 go to billing.",
      "a2: The archive API lives at /v2.",
    ]);
    const current = await readPartition(store.id, "agent-1");
    expect(current.revision).toBe(3);
    expect(contents(current.entries)).toEqual([
      "a1: Refunds over $800 go to billing.",
    ]);
    expect(await readPartitionAt(store.id, "agent-1", 0)).toEqual([]);
  });

  it("restores an old version, of a live or a deleted entry, as a new change", async () => {
    const store = await makeStore();
    const { applyMemoryOps, listMemoryEntryVersions, readPartition } = memory;
    await applyMemoryOps(
      store.id,
      "agent-2",
      [{ op: "add", content: "First wording." }],
      { author: "human" },
    );
    await applyMemoryOps(
      store.id,
      "agent-2",
      [{ op: "delete", shortId: "a1" }],
      { author: "human" },
    );
    const [entry] = await db
      .select()
      .from(schema.memoryEntries)
      .where(eq(schema.memoryEntries.storeId, store.id));
    expect(entry.deletedAt).not.toBeNull();
    const versions = await listMemoryEntryVersions(entry.id);
    const added = versions.find((version) => version.op === "add");

    await applyMemoryOps(
      store.id,
      "agent-2",
      [{ op: "restore", shortId: "a1", versionId: added?.id as string }],
      { author: "human" },
    );

    expect(
      contents((await readPartition(store.id, "agent-2")).entries),
    ).toEqual(["a1: First wording."]);
    expect(
      (await listMemoryEntryVersions(entry.id)).map((version) => version.op),
    ).toEqual(["restore", "delete", "add"]);
    const [restored] = await db
      .select()
      .from(schema.memoryEntries)
      .where(eq(schema.memoryEntries.id, entry.id));
    expect(restored.deletedAt).toBeNull();
  });

  it("writes one version per entry for a batch that adds and then edits it", async () => {
    const store = await makeStore("custom");
    const { applyMemoryOps, readPartition } = memory;

    await applyMemoryOps(
      store.id,
      "team-ops",
      [
        { op: "add", content: "Draft." },
        { op: "update", shortId: "c1", content: "Final." },
        { op: "add", content: "Gone before it existed." },
        { op: "delete", shortId: "c2" },
      ],
      { author: "agent" },
    );

    const versions = await db.select().from(schema.memoryEntryVersions);
    const ours = versions.filter((version) => version.revision === 1);
    expect(
      contents((await readPartition(store.id, "team-ops")).entries),
    ).toEqual(["c1: Final."]);
    expect(ours.filter((version) => version.content === "Final.")).toHaveLength(
      1,
    );
    expect(
      await db
        .select()
        .from(schema.memoryEntries)
        .where(eq(schema.memoryEntries.shortId, "c2")),
    ).toHaveLength(0);
  });

  it("refuses what the rules forbid, and changes nothing when it does", async () => {
    const store = await makeStore("agent_subject", 1000);
    const { applyMemoryOps, readPartition, setMemoryEntryPinned } = memory;
    await applyMemoryOps(
      store.id,
      "user-42",
      [{ op: "add", content: "Prefers Spanish." }],
      { author: "human" },
    );
    const [entry] = await db
      .select()
      .from(schema.memoryEntries)
      .where(eq(schema.memoryEntries.storeId, store.id));
    await setMemoryEntryPinned(store.id, entry.id, true);

    const attempts: Array<
      [Parameters<typeof applyMemoryOps>[2], string, string]
    > = [
      [
        [{ op: "update", shortId: "s1", content: "Prefers English." }],
        "agent",
        "pinned",
      ],
      [[{ op: "delete", shortId: "s9" }], "human", "entry_not_found"],
      [[{ op: "add", content: "   " }], "human", "invalid_content"],
      [[{ op: "add", content: "x".repeat(501) }], "human", "invalid_content"],
      [
        [
          { op: "add", content: "y".repeat(500) },
          { op: "add", content: "z".repeat(500) },
        ],
        "human",
        "full",
      ],
    ];
    for (const [ops, author, code] of attempts)
      await expect(
        applyMemoryOps(store.id, "user-42", ops, {
          author: author as "agent" | "human",
        }),
      ).rejects.toMatchObject({ code });

    const current = await readPartition(store.id, "user-42");
    expect(current.revision).toBe(1);
    expect(contents(current.entries)).toEqual(["s1: Prefers Spanish."]);
    await expect(
      applyMemoryOps(
        store.id,
        "user-42",
        [{ op: "update", shortId: "s1", content: "Prefers English." }],
        { author: "human" },
      ),
    ).resolves.toMatchObject({ revision: 2 });
  });

  async function makeRun() {
    const [agent] = await db
      .insert(schema.agents)
      .values({
        name: `agent ${crypto.randomUUID()}`,
        slug: crypto.randomUUID(),
        model: "test/model",
      })
      .returning();
    const [run] = await db
      .insert(schema.agentRuns)
      .values({ agentId: agent.id, source: "v1", durationMs: 1 })
      .returning();
    return run.id;
  }

  it("commits a run's writes once, skipping only what collides with changes made meanwhile", async () => {
    const store = await makeStore("agent", 1000);
    const { applyMemoryOps, readPartition, setMemoryEntryPinned } = memory;
    await applyMemoryOps(
      store.id,
      "agent-9",
      [
        { op: "add", content: "Kept." },
        { op: "add", content: "Will be pinned." },
        { op: "add", content: "Will be deleted." },
      ],
      { author: "human" },
    );
    const [pinned] = await db
      .select()
      .from(schema.memoryEntries)
      .where(
        and(
          eq(schema.memoryEntries.storeId, store.id),
          eq(schema.memoryEntries.shortId, "a2"),
        ),
      );
    await setMemoryEntryPinned(store.id, pinned.id, true);
    await applyMemoryOps(
      store.id,
      "agent-9",
      [{ op: "delete", shortId: "a3" }],
      { author: "human" },
    );
    const runId = await makeRun();
    const ops: Parameters<typeof applyMemoryOps>[2] = [
      { op: "update", shortId: "a2", content: "Changed by the agent." },
      { op: "delete", shortId: "a3" },
      { op: "add", content: "x".repeat(495) },
      { op: "add", content: "y".repeat(495) },
    ];

    const first = await applyMemoryOps(store.id, "agent-9", ops, {
      author: "agent",
      runId,
      skipConflicts: true,
    });
    const again = await applyMemoryOps(store.id, "agent-9", ops, {
      author: "agent",
      runId,
      skipConflicts: true,
    });

    expect(first.skipped).toEqual([
      "Entry a2 is pinned: only a person can change it.",
      "Entry a3 does not exist.",
    ]);
    expect(first.chars).toBe(5 + 15 + 495 + 495);
    expect(again).toEqual({
      revision: first.revision,
      chars: first.chars,
      skipped: [],
    });
    expect(
      contents((await readPartition(store.id, "agent-9")).entries),
    ).toEqual([
      "a1: Kept.",
      "a2: Will be pinned.",
      `a4: ${"x".repeat(495)}`,
      `a5: ${"y".repeat(495)}`,
    ]);
  });

  it("holds proposals for approval, applies an approved one as the agent and refuses one whose entry changed", async () => {
    const store = await makeStore("custom");
    const {
      applyMemoryOps,
      decideMemoryProposal,
      proposeMemoryOps,
      readPartition,
    } = memory;
    await applyMemoryOps(
      store.id,
      "team",
      [{ op: "add", content: "Deploys on Fridays." }],
      { author: "human" },
    );
    const runId = await makeRun();
    const ops: Parameters<typeof proposeMemoryOps>[3] = [
      { op: "add", content: "Freeze in December." },
      { op: "update", shortId: "c1", content: "Deploys on Thursdays." },
      { op: "delete", shortId: "c1" },
    ];
    await proposeMemoryOps(store.id, "team", 1, ops, runId);
    await proposeMemoryOps(store.id, "team", 1, ops, runId);

    const proposals = await db
      .select()
      .from(schema.memoryProposals)
      .where(eq(schema.memoryProposals.storeId, store.id));
    expect(proposals.map((proposal) => proposal.op)).toEqual([
      "add",
      "update",
      "delete",
    ]);
    const [add, update, remove] = proposals;

    await expect(
      decideMemoryProposal(store.id, add.id, true),
    ).resolves.toMatchObject({ status: "approved", reason: null });
    await expect(
      decideMemoryProposal(store.id, update.id, true),
    ).resolves.toMatchObject({ status: "approved", reason: null });
    await expect(
      decideMemoryProposal(store.id, remove.id, true),
    ).resolves.toMatchObject({
      status: "rejected",
      reason:
        "The entry changed after the run proposed this, so it was not applied.",
    });
    await expect(
      decideMemoryProposal(store.id, add.id, true),
    ).rejects.toMatchObject({ code: "proposal_not_found" });

    expect(contents((await readPartition(store.id, "team")).entries)).toEqual([
      "c1: Deploys on Thursdays.",
      "c2: Freeze in December.",
    ]);
    const versions = await db
      .select()
      .from(schema.memoryEntryVersions)
      .where(eq(schema.memoryEntryVersions.runId, runId));
    expect(versions.map((version) => version.author)).toEqual([
      "agent",
      "agent",
    ]);
  });
  it("applies a proposal once when it is approved twice at the same time, and reopens it when it does not fit", async () => {
    const store = await makeStore("agent", 30);
    const { decideMemoryProposal, proposeMemoryOps, readPartition } = memory;
    await proposeMemoryOps(
      store.id,
      "agent-2",
      0,
      [{ op: "add", content: "Deploys on Fridays." }],
      null,
    );
    const [proposal] = await db
      .select()
      .from(schema.memoryProposals)
      .where(eq(schema.memoryProposals.storeId, store.id));

    const outcomes = await Promise.allSettled([
      decideMemoryProposal(store.id, proposal.id, true),
      decideMemoryProposal(store.id, proposal.id, true),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect((await readPartition(store.id, "agent-2")).entries).toHaveLength(1);

    await proposeMemoryOps(
      store.id,
      "agent-2",
      1,
      [{ op: "add", content: "Freeze in December." }],
      null,
    );
    const [pending] = await db
      .select()
      .from(schema.memoryProposals)
      .where(
        and(
          eq(schema.memoryProposals.storeId, store.id),
          eq(schema.memoryProposals.status, "pending"),
        ),
      );
    await expect(
      decideMemoryProposal(store.id, pending.id, true),
    ).rejects.toMatchObject({ code: "full" });
    const [after] = await db
      .select()
      .from(schema.memoryProposals)
      .where(eq(schema.memoryProposals.id, pending.id));
    expect(after).toMatchObject({ status: "pending", decidedAt: null });
  });

  it("forgets a subject: its memories, transcripts, fix drafts and schedules go, its runs stay without it", async () => {
    const perSubject = await makeStore("agent_subject");
    const custom = await makeStore("custom");
    const agentId = perSubject.ownerAgentId;
    const { applyMemoryOps } = memory;
    const { forgetSubject, getSubjectFootprint } = await import(
      "../../src/subjects"
    );
    const subject = `customer-${crypto.randomUUID()}`;
    const other = `customer-${crypto.randomUUID()}`;
    for (const key of [subject, other])
      await applyMemoryOps(
        perSubject.id,
        key,
        [{ op: "add", content: "Prefers email." }],
        {
          author: "human",
        },
      );
    await applyMemoryOps(
      custom.id,
      subject,
      [{ op: "add", content: "Team fact." }],
      {
        author: "human",
      },
    );

    const runs = await db
      .insert(schema.agentRuns)
      .values(
        [subject, subject, other].map((subjectId) => ({
          agentId,
          source: "v1",
          durationMs: 1,
          subjectId,
          memorySeen: [
            { storeId: perSubject.id, partitionKey: subjectId, revision: 1 },
          ],
        })),
      )
      .returning();
    await db
      .insert(schema.runTranscripts)
      .values(runs.map((run) => ({ runId: run.id, input: [], output: [] })));
    await db.insert(schema.fixDrafts).values(
      runs.map((run) => ({
        runId: run.id,
        messageId: "m1",
        anchor: {},
        category: "prompt",
        rationale: "Quotes the customer.",
      })),
    );
    await db.insert(schema.schedules).values({
      agentId,
      name: "Follow-up",
      frequency: "daily",
      timeOfDay: "10:00",
      timezone: "UTC",
      input: "Follow up.",
      subjectId: subject,
    });

    expect(await getSubjectFootprint(subject)).toMatchObject({
      memories: 1,
      runs: 2,
      transcripts: 2,
      schedules: [{ name: "Follow-up" }],
    });
    expect(await forgetSubject(subject)).toEqual({
      memories: 1,
      runs: 2,
      transcripts: 2,
      schedules: 1,
    });
    expect(await getSubjectFootprint(subject)).toEqual({
      memories: 0,
      runs: 0,
      transcripts: 0,
      schedules: [],
    });

    const partitions = await db
      .select({
        storeId: schema.memoryPartitions.storeId,
        key: schema.memoryPartitions.partitionKey,
      })
      .from(schema.memoryPartitions)
      .where(
        inArray(schema.memoryPartitions.storeId, [perSubject.id, custom.id]),
      );
    expect(partitions).toHaveLength(2);
    expect(partitions).toEqual(
      expect.arrayContaining([
        { storeId: perSubject.id, key: other },
        { storeId: custom.id, key: subject },
      ]),
    );

    const after = await db
      .select()
      .from(schema.agentRuns)
      .where(
        inArray(
          schema.agentRuns.id,
          runs.map((run) => run.id),
        ),
      );
    expect(
      after.map((run) => [
        run.id === runs[2].id,
        run.subjectId,
        run.memorySeen,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [false, null, null],
        [false, null, null],
        [true, other, runs[2].memorySeen],
      ]),
    );
    const transcripts = await db
      .select({ runId: schema.runTranscripts.runId })
      .from(schema.runTranscripts)
      .where(
        inArray(
          schema.runTranscripts.runId,
          runs.map((run) => run.id),
        ),
      );
    const drafts = await db
      .select({ runId: schema.fixDrafts.runId })
      .from(schema.fixDrafts)
      .where(
        inArray(
          schema.fixDrafts.runId,
          runs.map((run) => run.id),
        ),
      );
    expect(transcripts).toEqual([{ runId: runs[2].id }]);
    expect(drafts).toEqual([{ runId: runs[2].id }]);
  });
});
