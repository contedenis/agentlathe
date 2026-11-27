import {
  agents,
  applyMemoryOps,
  COMPACTION_TARGET_SHARE,
  COMPACTION_TRIGGER_SHARE,
  db,
  getPool,
  type MemoryOp,
  MemoryWriteError,
  memoryCompactions,
  memoryPartitions,
  memoryStores,
  readPartitionAt,
} from "@agentlathe/db";
import {
  CompactionError,
  type CompactionPlan,
  type MemoryPartitionRef,
  planCompaction,
} from "@agentlathe/runner";
import { and, desc, eq } from "drizzle-orm";
import { after } from "next/server";
import { createLimiter } from "./limiter";

const compactionLimit = createLimiter(2);
const COMPACTION_TIMEOUT_MS = 3 * 60 * 1000;

export type CompactionDetail = {
  operations: CompactionPlan["operations"];
  beforeChars: number;
  afterChars: number;
};

export type CompactionOutcome =
  | { status: "skipped" | "busy"; reason: string }
  | { status: "applied" | "failed"; compactionId: string };

function opsOf(plan: CompactionPlan["operations"]): MemoryOp[] {
  return plan.flatMap((operation): MemoryOp[] => {
    if (operation.op === "keep") return [];
    if (operation.op === "delete")
      return [{ op: "delete", shortId: operation.id }];
    const [first, ...rest] = operation.ids;
    return [
      { op: "compact", shortId: first, content: operation.content },
      ...rest.map((shortId) => ({ op: "delete" as const, shortId })),
    ];
  });
}

async function finish(
  compactionId: string,
  values: Partial<typeof memoryCompactions.$inferInsert>,
) {
  await db
    .update(memoryCompactions)
    .set({ ...values, finishedAt: new Date() })
    .where(eq(memoryCompactions.id, compactionId));
}

export function compactionTarget(charLimit: number): number {
  return Math.floor(charLimit * COMPACTION_TARGET_SHARE);
}

export async function compactPartition(
  storeId: string,
  partitionKey: string,
): Promise<CompactionOutcome> {
  const [store] = await db
    .select({
      isActive: memoryStores.isActive,
      charLimit: memoryStores.charLimit,
      purpose: memoryStores.purpose,
      model: agents.model,
    })
    .from(memoryStores)
    .innerJoin(agents, eq(agents.id, memoryStores.ownerAgentId))
    .where(eq(memoryStores.id, storeId));
  if (!store?.isActive)
    return { status: "skipped", reason: "The memory is not active." };

  const client = await getPool().connect();
  let locked = false;
  try {
    const lock = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
      [`memory-compaction:${storeId}:${partitionKey}`],
    );
    locked = lock.rows[0]?.locked === true;
    if (!locked)
      return { status: "busy", reason: "A compaction is already running." };

    const [partition] = await db
      .select()
      .from(memoryPartitions)
      .where(
        and(
          eq(memoryPartitions.storeId, storeId),
          eq(memoryPartitions.partitionKey, partitionKey),
        ),
      );
    if (
      !partition ||
      partition.chars <= store.charLimit * COMPACTION_TRIGGER_SHARE
    )
      return { status: "skipped", reason: "The memory is not full enough." };

    const entries = await readPartitionAt(
      storeId,
      partitionKey,
      partition.revision,
    );
    const target = compactionTarget(store.charLimit);
    const pinned = entries
      .filter((entry) => entry.pinned)
      .reduce((sum, entry) => sum + entry.content.length, 0);
    if (pinned > target)
      return {
        status: "skipped",
        reason: "Pinned entries alone take more than compaction can keep.",
      };

    const [row] = await db
      .insert(memoryCompactions)
      .values({
        storeId,
        partitionKey,
        fromRevision: partition.revision,
        model: store.model,
        status: "running",
      })
      .returning({ id: memoryCompactions.id });

    let tokens = { inputTokens: 0, outputTokens: 0 };
    try {
      const planned = await planCompaction({
        model: store.model,
        purpose: store.purpose,
        entries,
        target,
        abortSignal: AbortSignal.timeout(COMPACTION_TIMEOUT_MS),
      });
      tokens = {
        inputTokens: planned.inputTokens,
        outputTokens: planned.outputTokens,
      };
      const { revision: toRevision } = await applyMemoryOps(
        storeId,
        partitionKey,
        opsOf(planned.plan.operations),
        { author: "compaction", expectedRevision: partition.revision },
      );
      await db
        .update(memoryPartitions)
        .set({ compactedAt: new Date() })
        .where(
          and(
            eq(memoryPartitions.storeId, storeId),
            eq(memoryPartitions.partitionKey, partitionKey),
          ),
        );
      const detail: CompactionDetail = {
        operations: planned.plan.operations,
        beforeChars: entries.reduce((sum, e) => sum + e.content.length, 0),
        afterChars: planned.chars,
      };
      await finish(row.id, {
        status: "applied",
        operations: detail,
        toRevision,
        ...tokens,
      });
      return { status: "applied", compactionId: row.id };
    } catch (err) {
      if (err instanceof CompactionError)
        tokens = {
          inputTokens: err.inputTokens,
          outputTokens: err.outputTokens,
        };
      const error =
        err instanceof MemoryWriteError && err.code === "stale"
          ? "The memory changed while it was being compacted; it compacts again on the next change."
          : err instanceof Error
            ? err.message
            : String(err);
      await finish(row.id, { status: "failed", error, ...tokens });
      return { status: "failed", compactionId: row.id };
    }
  } finally {
    if (locked)
      await client
        .query("select pg_advisory_unlock(hashtextextended($1, 0))", [
          `memory-compaction:${storeId}:${partitionKey}`,
        ])
        .catch(() => {});
    client.release();
  }
}

export function scheduleCompaction(partitions: MemoryPartitionRef[]): void {
  for (const { storeId, partitionKey } of partitions) {
    const compaction = compactionLimit(() =>
      compactPartition(storeId, partitionKey),
    ).then(
      () => {},
      (err) => console.error("memory compaction failed", err),
    );
    try {
      after(compaction);
    } catch {}
  }
}

export function listCompactions(storeId: string, partitionKey: string) {
  return db
    .select()
    .from(memoryCompactions)
    .where(
      and(
        eq(memoryCompactions.storeId, storeId),
        eq(memoryCompactions.partitionKey, partitionKey),
      ),
    )
    .orderBy(desc(memoryCompactions.createdAt))
    .limit(10);
}

export type CompactionRow = Awaited<ReturnType<typeof listCompactions>>[number];
