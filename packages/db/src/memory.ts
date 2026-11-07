import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "./client";
import {
  MEMORY_ENTRY_MAX_LENGTH,
  MEMORY_SHORT_ID_PREFIX,
  type MemoryAuthor,
  type MemoryEntryOp,
  type MemoryScope,
} from "./constants";
import {
  memoryEntries,
  memoryEntryVersions,
  memoryPartitions,
  memoryProposals,
  memoryStores,
} from "./schema";

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type MemoryEntryState = {
  id: string;
  shortId: string;
  content: string;
  pinned: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export async function readPartitionAt(
  storeId: string,
  partitionKey: string,
  revision: number,
  executor: Executor = db,
): Promise<MemoryEntryState[]> {
  const rows = await executor
    .selectDistinctOn([memoryEntryVersions.entryId], {
      id: memoryEntries.id,
      shortId: memoryEntries.shortId,
      pinned: memoryEntries.pinned,
      createdAt: memoryEntries.createdAt,
      content: memoryEntryVersions.content,
      op: memoryEntryVersions.op,
      updatedAt: memoryEntryVersions.createdAt,
    })
    .from(memoryEntryVersions)
    .innerJoin(memoryEntries, eq(memoryEntries.id, memoryEntryVersions.entryId))
    .where(
      and(
        eq(memoryEntries.storeId, storeId),
        eq(memoryEntries.partitionKey, partitionKey),
        lte(memoryEntryVersions.revision, revision),
      ),
    )
    .orderBy(memoryEntryVersions.entryId, desc(memoryEntryVersions.revision));
  return rows
    .flatMap(({ op, content, ...entry }) =>
      op === "delete" || content === null ? [] : [{ ...entry, content }],
    )
    .sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        Number(a.shortId.slice(1)) - Number(b.shortId.slice(1)),
    );
}

export async function readPartition(storeId: string, partitionKey: string) {
  const [partition] = await db
    .select({ revision: memoryPartitions.revision })
    .from(memoryPartitions)
    .where(
      and(
        eq(memoryPartitions.storeId, storeId),
        eq(memoryPartitions.partitionKey, partitionKey),
      ),
    );
  const revision = partition?.revision ?? 0;
  return {
    revision,
    entries: await readPartitionAt(storeId, partitionKey, revision),
  };
}

export type MemoryOp =
  | { op: "add"; content: string }
  | { op: "update"; shortId: string; content: string }
  | { op: "delete"; shortId: string }
  | { op: "restore"; shortId: string; versionId: string }
  | { op: "compact"; shortId: string; content: string };

export type MemoryWriteErrorCode =
  | "store_not_found"
  | "entry_not_found"
  | "pinned"
  | "invalid_content"
  | "full"
  | "proposal_not_found"
  | "stale";

export class MemoryWriteError extends Error {
  constructor(
    readonly code: MemoryWriteErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function checkEntryContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed)
    throw new MemoryWriteError("invalid_content", "An entry cannot be empty.");
  if (trimmed.length > MEMORY_ENTRY_MAX_LENGTH)
    throw new MemoryWriteError(
      "invalid_content",
      `An entry holds at most ${MEMORY_ENTRY_MAX_LENGTH} characters; this one has ${trimmed.length}.`,
    );
  return trimmed;
}

type Change = {
  entryId: string | null;
  op: MemoryEntryOp;
  content: string | null;
};

export async function applyMemoryOps(
  storeId: string,
  partitionKey: string,
  ops: MemoryOp[],
  {
    author,
    runId = null,
    skipConflicts = false,
    expectedRevision,
  }: {
    author: MemoryAuthor;
    runId?: string | null;
    skipConflicts?: boolean;
    expectedRevision?: number;
  },
): Promise<{ revision: number; chars: number; skipped: string[] }> {
  return db.transaction(async (tx) => {
    const [store] = await tx
      .select({ scope: memoryStores.scope, charLimit: memoryStores.charLimit })
      .from(memoryStores)
      .where(eq(memoryStores.id, storeId));
    if (!store)
      throw new MemoryWriteError(
        "store_not_found",
        "The memory store does not exist.",
      );

    await tx
      .insert(memoryPartitions)
      .values({ storeId, partitionKey })
      .onConflictDoNothing();
    const [partition] = await tx
      .select()
      .from(memoryPartitions)
      .where(
        and(
          eq(memoryPartitions.storeId, storeId),
          eq(memoryPartitions.partitionKey, partitionKey),
        ),
      )
      .for("update");

    if (
      expectedRevision !== undefined &&
      partition.revision !== expectedRevision
    )
      throw new MemoryWriteError(
        "stale",
        "The memory changed since this was prepared.",
      );

    if (skipConflicts && runId) {
      const [committed] = await tx
        .select({ id: memoryEntryVersions.id })
        .from(memoryEntryVersions)
        .innerJoin(
          memoryEntries,
          eq(memoryEntries.id, memoryEntryVersions.entryId),
        )
        .where(
          and(
            eq(memoryEntryVersions.runId, runId),
            eq(memoryEntries.storeId, storeId),
            eq(memoryEntries.partitionKey, partitionKey),
          ),
        )
        .limit(1);
      if (committed)
        return {
          revision: partition.revision,
          chars: partition.chars,
          skipped: [],
        };
    }

    const current = await readPartitionAt(
      storeId,
      partitionKey,
      partition.revision,
      tx,
    );
    const state = new Map(
      current.map((entry) => [entry.shortId, entry.content as string | null]),
    );
    const pinned = new Set(
      current.filter((entry) => entry.pinned).map((entry) => entry.shortId),
    );
    const known = new Map<string, string | null>(
      current.map((entry) => [entry.shortId, entry.id]),
    );
    const changes = new Map<string, Change>();
    let nextNumber = partition.nextEntryNumber;
    const prefix = MEMORY_SHORT_ID_PREFIX[store.scope as MemoryScope];

    const entryIdOf = async (shortId: string) => {
      if (known.has(shortId)) return known.get(shortId) ?? null;
      const [row] = await tx
        .select({ id: memoryEntries.id, pinned: memoryEntries.pinned })
        .from(memoryEntries)
        .where(
          and(
            eq(memoryEntries.storeId, storeId),
            eq(memoryEntries.partitionKey, partitionKey),
            eq(memoryEntries.shortId, shortId),
          ),
        );
      if (row?.pinned) pinned.add(shortId);
      known.set(shortId, row?.id ?? null);
      return row?.id ?? null;
    };
    const record = (
      shortId: string,
      op: MemoryEntryOp,
      content: string | null,
    ) => {
      const previous = changes.get(shortId);
      changes.set(shortId, {
        entryId: known.get(shortId) ?? null,
        op: previous?.op === "add" && op !== "delete" ? "add" : op,
        content,
      });
      state.set(shortId, op === "delete" ? null : content);
    };
    const guard = (shortId: string) => {
      if (author !== "human" && pinned.has(shortId))
        throw new MemoryWriteError(
          "pinned",
          `Entry ${shortId} is pinned: only a person can change it.`,
        );
    };

    const skipped: string[] = [];
    const apply = async (op: MemoryOp) => {
      if (op.op === "add") {
        const shortId = `${prefix}${nextNumber++}`;
        known.set(shortId, null);
        record(shortId, "add", checkEntryContent(op.content));
        return;
      }
      const alive = state.get(op.shortId);
      if (op.op === "restore") {
        const entryId = await entryIdOf(op.shortId);
        const [version] = entryId
          ? await tx
              .select({ content: memoryEntryVersions.content })
              .from(memoryEntryVersions)
              .where(
                and(
                  eq(memoryEntryVersions.id, op.versionId),
                  eq(memoryEntryVersions.entryId, entryId),
                ),
              )
          : [];
        if (!version?.content)
          throw new MemoryWriteError(
            "entry_not_found",
            `Entry ${op.shortId} has no such version to restore.`,
          );
        guard(op.shortId);
        record(op.shortId, "restore", version.content);
        return;
      }
      if (alive === undefined || alive === null)
        throw new MemoryWriteError(
          "entry_not_found",
          `Entry ${op.shortId} does not exist.`,
        );
      guard(op.shortId);
      if (op.op === "update" || op.op === "compact")
        record(
          op.shortId,
          op.op === "update" ? "update" : "compaction",
          checkEntryContent(op.content),
        );
      else record(op.shortId, "delete", null);
    };
    for (const op of ops) {
      if (!skipConflicts) {
        await apply(op);
        continue;
      }
      try {
        await apply(op);
      } catch (err) {
        if (!(err instanceof MemoryWriteError)) throw err;
        skipped.push(err.message);
      }
    }

    const chars = [...state.values()].reduce(
      (sum, content) => sum + (content?.length ?? 0),
      0,
    );
    if (!skipConflicts && chars > store.charLimit && chars > partition.chars)
      throw new MemoryWriteError(
        "full",
        `Memory full (${chars.toLocaleString("en-US")} / ${store.charLimit.toLocaleString("en-US")} characters): update or delete entries.`,
      );

    const pending = [...changes.entries()].filter(
      ([, change]) => !(change.entryId === null && change.op === "delete"),
    );
    if (pending.length === 0)
      return { revision: partition.revision, chars: partition.chars, skipped };
    const created = pending.filter(([, change]) => change.entryId === null);
    if (created.length > 0) {
      const rows = await tx
        .insert(memoryEntries)
        .values(
          created.map(([shortId]) => ({ storeId, partitionKey, shortId })),
        )
        .returning({ id: memoryEntries.id, shortId: memoryEntries.shortId });
      for (const row of rows) {
        const change = changes.get(row.shortId);
        if (change) change.entryId = row.id;
      }
    }

    const revision = partition.revision + 1;
    const now = new Date();
    if (pending.length > 0) {
      await tx.insert(memoryEntryVersions).values(
        pending.map(([, change]) => ({
          entryId: change.entryId as string,
          revision,
          op: change.op,
          content: change.content,
          runId,
          author,
        })),
      );
      const deleted = pending
        .filter(([, change]) => change.op === "delete")
        .map(([, change]) => change.entryId as string);
      const alive = pending
        .filter(([, change]) => change.op !== "delete")
        .map(([, change]) => change.entryId as string);
      if (deleted.length > 0)
        await tx
          .update(memoryEntries)
          .set({ deletedAt: now, updatedAt: now })
          .where(inArray(memoryEntries.id, deleted));
      if (alive.length > 0)
        await tx
          .update(memoryEntries)
          .set({ deletedAt: null, updatedAt: now })
          .where(inArray(memoryEntries.id, alive));
    }
    await tx
      .update(memoryPartitions)
      .set({ revision, chars, nextEntryNumber: nextNumber, updatedAt: now })
      .where(
        and(
          eq(memoryPartitions.storeId, storeId),
          eq(memoryPartitions.partitionKey, partitionKey),
        ),
      );
    return { revision, chars, skipped };
  });
}

export async function setMemoryEntryPinned(
  storeId: string,
  entryId: string,
  pinned: boolean,
) {
  const [row] = await db
    .update(memoryEntries)
    .set({ pinned, updatedAt: new Date() })
    .where(
      and(eq(memoryEntries.id, entryId), eq(memoryEntries.storeId, storeId)),
    )
    .returning();
  return row ?? null;
}

export function listMemoryEntryVersions(entryId: string) {
  return db
    .select({
      id: memoryEntryVersions.id,
      revision: memoryEntryVersions.revision,
      op: memoryEntryVersions.op,
      content: memoryEntryVersions.content,
      author: memoryEntryVersions.author,
      runId: memoryEntryVersions.runId,
      createdAt: memoryEntryVersions.createdAt,
    })
    .from(memoryEntryVersions)
    .where(eq(memoryEntryVersions.entryId, entryId))
    .orderBy(
      desc(memoryEntryVersions.revision),
      asc(memoryEntryVersions.createdAt),
    );
}

export async function proposeMemoryOps(
  storeId: string,
  partitionKey: string,
  baseRevision: number,
  ops: MemoryOp[],
  runId: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(memoryPartitions)
      .values({ storeId, partitionKey })
      .onConflictDoNothing();
    const inPartition = and(
      eq(memoryProposals.storeId, storeId),
      eq(memoryProposals.partitionKey, partitionKey),
    );
    if (runId) {
      const [proposed] = await tx
        .select({ id: memoryProposals.id })
        .from(memoryProposals)
        .where(and(inPartition, eq(memoryProposals.runId, runId)))
        .limit(1);
      if (proposed) return;
    }
    const shortIds = ops.flatMap((op) => ("shortId" in op ? [op.shortId] : []));
    const entries = shortIds.length
      ? await tx
          .select({ id: memoryEntries.id, shortId: memoryEntries.shortId })
          .from(memoryEntries)
          .where(
            and(
              eq(memoryEntries.storeId, storeId),
              eq(memoryEntries.partitionKey, partitionKey),
              inArray(memoryEntries.shortId, shortIds),
            ),
          )
      : [];
    const entryIdOf = new Map(
      entries.map((entry) => [entry.shortId, entry.id]),
    );
    const rows = ops.flatMap((op) => {
      if (op.op === "restore") return [];
      const entryId = op.op === "add" ? null : entryIdOf.get(op.shortId);
      if (entryId === undefined) return [];
      return [
        {
          storeId,
          partitionKey,
          op: op.op,
          entryId,
          content: op.op === "delete" ? null : op.content,
          baseRevision,
          runId,
        },
      ];
    });
    if (rows.length > 0) await tx.insert(memoryProposals).values(rows);
  });
}

export async function decideMemoryProposal(
  storeId: string,
  proposalId: string,
  approve: boolean,
): Promise<{
  status: "approved" | "rejected";
  reason: string | null;
  partitionKey: string;
}> {
  const [proposal] = await db
    .update(memoryProposals)
    .set({
      status: approve ? "approved" : "rejected",
      decidedAt: new Date(),
    })
    .where(
      and(
        eq(memoryProposals.id, proposalId),
        eq(memoryProposals.storeId, storeId),
        eq(memoryProposals.status, "pending"),
      ),
    )
    .returning();
  if (!proposal)
    throw new MemoryWriteError(
      "proposal_not_found",
      "There is no pending proposal with this id.",
    );
  const decided = (
    status: "approved" | "rejected",
    reason: string | null = null,
  ) => ({ status, reason, partitionKey: proposal.partitionKey });
  if (!approve) return decided("rejected");

  const reopen = (
    values: Partial<typeof memoryProposals.$inferInsert> = {
      status: "pending",
      decidedAt: null,
    },
  ) =>
    db
      .update(memoryProposals)
      .set(values)
      .where(eq(memoryProposals.id, proposalId));

  let op: MemoryOp;
  if (proposal.op === "add")
    op = { op: "add", content: proposal.content ?? "" };
  else {
    const [entry] = await db
      .select({
        shortId: memoryEntries.shortId,
        revision: sql<number>`max(${memoryEntryVersions.revision})`.mapWith(
          Number,
        ),
      })
      .from(memoryEntries)
      .innerJoin(
        memoryEntryVersions,
        eq(memoryEntryVersions.entryId, memoryEntries.id),
      )
      .where(eq(memoryEntries.id, proposal.entryId ?? ""))
      .groupBy(memoryEntries.shortId);
    if (!entry || entry.revision > proposal.baseRevision) {
      const reason =
        "The entry changed after the run proposed this, so it was not applied.";
      await reopen({ status: "rejected", reason });
      return decided("rejected", reason);
    }
    op =
      proposal.op === "update"
        ? {
            op: "update",
            shortId: entry.shortId,
            content: proposal.content ?? "",
          }
        : { op: "delete", shortId: entry.shortId };
  }
  try {
    await applyMemoryOps(storeId, proposal.partitionKey, [op], {
      author: "agent",
      runId: proposal.runId,
    });
  } catch (err) {
    await reopen();
    throw err;
  }
  return decided("approved");
}
