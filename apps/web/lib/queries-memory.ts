import {
  agentRuns,
  agents,
  db,
  isUuid,
  type MemoryScope,
  type MemorySeen,
  memoryEntries,
  memoryEntryVersions,
  memoryPartitions,
  memoryProposals,
  memoryStores,
  readPartition,
  readPartitionAt,
} from "@agentlathe/db";
import type { MemoryStoreView } from "@agentlathe/runner";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  sql,
  sum,
} from "drizzle-orm";

export async function listMemoryStores() {
  const [stores, usage] = await Promise.all([
    db
      .select({ store: memoryStores, ownerName: agents.name })
      .from(memoryStores)
      .innerJoin(agents, eq(agents.id, memoryStores.ownerAgentId))
      .orderBy(
        asc(agents.name),
        asc(memoryStores.scope),
        asc(memoryStores.name),
      ),
    db
      .select({
        storeId: memoryPartitions.storeId,
        partitions: count(),
        chars: sum(memoryPartitions.chars).mapWith(Number),
      })
      .from(memoryPartitions)
      .groupBy(memoryPartitions.storeId),
  ]);
  const usageOf = new Map(usage.map((row) => [row.storeId, row]));
  return stores.map(({ store, ownerName }) => ({
    ...store,
    scope: store.scope as MemoryScope,
    owner: { id: store.ownerAgentId, name: ownerName },
    partitions: usageOf.get(store.id)?.partitions ?? 0,
    chars: usageOf.get(store.id)?.chars ?? 0,
  }));
}

export type MemoryStoreListRow = Awaited<
  ReturnType<typeof listMemoryStores>
>[number];

export async function getMemoryStore(id: string) {
  if (!isUuid(id)) return undefined;
  const [row] = await db
    .select({ store: memoryStores, ownerName: agents.name })
    .from(memoryStores)
    .innerJoin(agents, eq(agents.id, memoryStores.ownerAgentId))
    .where(eq(memoryStores.id, id));
  if (!row) return undefined;
  const { store, ownerName } = row;
  const scope = store.scope as MemoryScope;
  const owner = { id: store.ownerAgentId, name: ownerName };
  const [partitions, alive, waiting] = await Promise.all([
    db
      .select()
      .from(memoryPartitions)
      .where(eq(memoryPartitions.storeId, id))
      .orderBy(desc(memoryPartitions.updatedAt)),
    db
      .select({ partitionKey: memoryEntries.partitionKey, entries: count() })
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.storeId, id),
          sql`${memoryEntries.deletedAt} is null`,
        ),
      )
      .groupBy(memoryEntries.partitionKey),
    db
      .select({ partitionKey: memoryProposals.partitionKey, pending: count() })
      .from(memoryProposals)
      .where(
        and(
          eq(memoryProposals.storeId, id),
          eq(memoryProposals.status, "pending"),
        ),
      )
      .groupBy(memoryProposals.partitionKey),
  ]);
  const entriesOf = new Map(
    alive.map((row) => [row.partitionKey, row.entries]),
  );
  const pendingOf = new Map(
    waiting.map((row) => [row.partitionKey, row.pending]),
  );
  return {
    ...store,
    scope,
    owner,
    title: `${owner.name} · ${store.name}`,
    partitions: partitions.map((partition) => ({
      partitionKey: partition.partitionKey,
      label: partition.partitionKey,
      revision: partition.revision,
      chars: partition.chars,
      entries: entriesOf.get(partition.partitionKey) ?? 0,
      pending: pendingOf.get(partition.partitionKey) ?? 0,
      updatedAt: partition.updatedAt,
    })),
  };
}

export type MemoryStoreDetail = NonNullable<
  Awaited<ReturnType<typeof getMemoryStore>>
>;

export async function getPartitionEntries(
  storeId: string,
  partitionKey: string,
) {
  const [current, deleted, proposals] = await Promise.all([
    readPartition(storeId, partitionKey),
    db
      .selectDistinctOn([memoryEntryVersions.entryId], {
        id: memoryEntries.id,
        shortId: memoryEntries.shortId,
        content: memoryEntryVersions.content,
        versionId: memoryEntryVersions.id,
        deletedAt: memoryEntries.deletedAt,
      })
      .from(memoryEntries)
      .innerJoin(
        memoryEntryVersions,
        eq(memoryEntryVersions.entryId, memoryEntries.id),
      )
      .where(
        and(
          eq(memoryEntries.storeId, storeId),
          eq(memoryEntries.partitionKey, partitionKey),
          isNotNull(memoryEntries.deletedAt),
          isNotNull(memoryEntryVersions.content),
        ),
      )
      .orderBy(memoryEntryVersions.entryId, desc(memoryEntryVersions.revision)),
    db
      .select({
        id: memoryProposals.id,
        op: memoryProposals.op,
        content: memoryProposals.content,
        shortId: memoryEntries.shortId,
        runId: memoryProposals.runId,
        createdAt: memoryProposals.createdAt,
      })
      .from(memoryProposals)
      .leftJoin(memoryEntries, eq(memoryEntries.id, memoryProposals.entryId))
      .where(
        and(
          eq(memoryProposals.storeId, storeId),
          eq(memoryProposals.partitionKey, partitionKey),
          eq(memoryProposals.status, "pending"),
        ),
      )
      .orderBy(asc(memoryProposals.createdAt)),
  ]);
  return {
    ...current,
    proposals,
    deleted: deleted.map((entry) => ({
      ...entry,
      content: entry.content ?? "",
    })),
  };
}

export async function getMemoryLoaded(
  seen: MemorySeen[] | null,
): Promise<Array<MemoryStoreView | { storeId: string; missing: true }>> {
  if (!seen?.length) return [];
  const stores = await db
    .select({ store: memoryStores, agentName: agents.name })
    .from(memoryStores)
    .innerJoin(agents, eq(agents.id, memoryStores.ownerAgentId))
    .where(
      inArray(
        memoryStores.id,
        seen.map((item) => item.storeId),
      ),
    )
    .then((rows) =>
      rows.map(({ store, agentName }) => ({ ...store, agentName })),
    );
  const storeOf = new Map(stores.map((store) => [store.id, store]));
  return Promise.all(
    seen.map(async ({ storeId, partitionKey, revision }) => {
      const store = storeOf.get(storeId);
      if (!store) return { storeId, missing: true as const };
      return {
        storeId,
        name: store.name,
        agentName: store.agentName,
        scope: store.scope as MemoryScope,
        purpose: store.purpose,
        charLimit: store.charLimit,
        partitionKey,
        revision,
        entries: await readPartitionAt(storeId, partitionKey, revision),
      };
    }),
  );
}

export async function listAgentMemoryStores(agentId: string) {
  const rows = await db
    .select({
      id: memoryStores.id,
      name: memoryStores.name,
      scope: memoryStores.scope,
      memoryKey: memoryStores.memoryKey,
      purpose: memoryStores.purpose,
      charLimit: memoryStores.charLimit,
      requireApproval: memoryStores.requireApproval,
      isActive: memoryStores.isActive,
    })
    .from(memoryStores)
    .where(eq(memoryStores.ownerAgentId, agentId))
    .orderBy(asc(memoryStores.scope));
  return rows.map((row) => ({ ...row, scope: row.scope as MemoryScope }));
}

export const WARNING_WINDOW_DAYS = 7;

export async function countRunWarnings(agentId: string) {
  const warning = sql`jsonb_array_elements(${agentRuns.warnings})`;
  const rows = await db
    .select({
      message: sql<string>`w.value->>'message'`,
      runs: sql<number>`count(distinct ${agentRuns.id})`.mapWith(Number),
    })
    .from(sql`${agentRuns} cross join lateral ${warning} as w(value)`)
    .where(
      and(
        eq(agentRuns.agentId, agentId),
        gt(
          agentRuns.createdAt,
          sql`now() - make_interval(days => ${WARNING_WINDOW_DAYS})`,
        ),
        sql`w.value->>'code' in ('memory_missing_subject', 'memory_missing_key', 'memory_key_mismatch', 'knowledge_too_large')`,
      ),
    )
    .groupBy(sql`w.value->>'message'`);
  return rows;
}

export async function getRunMemoryChanges(runId: string) {
  const before = sql<string | null>`(
    select previous.content from ${memoryEntryVersions} as previous
    where previous.entry_id = ${memoryEntryVersions.entryId}
      and previous.revision < ${memoryEntryVersions.revision}
    order by previous.revision desc limit 1
  )`;
  const [changes, proposals] = await Promise.all([
    db
      .select({
        id: memoryEntryVersions.id,
        op: memoryEntryVersions.op,
        content: memoryEntryVersions.content,
        before,
        shortId: memoryEntries.shortId,
        storeId: memoryStores.id,
        storeName: memoryStores.name,
        partitionKey: memoryEntries.partitionKey,
      })
      .from(memoryEntryVersions)
      .innerJoin(
        memoryEntries,
        eq(memoryEntries.id, memoryEntryVersions.entryId),
      )
      .innerJoin(memoryStores, eq(memoryStores.id, memoryEntries.storeId))
      .where(eq(memoryEntryVersions.runId, runId))
      .orderBy(asc(memoryStores.name), asc(memoryEntries.createdAt)),
    db
      .select({
        id: memoryProposals.id,
        op: memoryProposals.op,
        content: memoryProposals.content,
        status: memoryProposals.status,
        reason: memoryProposals.reason,
        shortId: memoryEntries.shortId,
        storeId: memoryStores.id,
        storeName: memoryStores.name,
        partitionKey: memoryProposals.partitionKey,
      })
      .from(memoryProposals)
      .innerJoin(memoryStores, eq(memoryStores.id, memoryProposals.storeId))
      .leftJoin(memoryEntries, eq(memoryEntries.id, memoryProposals.entryId))
      .where(eq(memoryProposals.runId, runId))
      .orderBy(asc(memoryProposals.createdAt)),
  ]);
  return { changes, proposals };
}

export type RunMemoryChanges = Awaited<ReturnType<typeof getRunMemoryChanges>>;
