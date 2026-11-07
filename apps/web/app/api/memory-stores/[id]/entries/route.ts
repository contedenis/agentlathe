import {
  applyMemoryOps,
  db,
  type MemoryScope,
  memoryPartitionKey,
  memoryStores,
} from "@agentlathe/db";
import { eq } from "drizzle-orm";
import { isUuid, parseBody } from "@/lib/api-helpers";
import { scheduleCompaction } from "@/lib/memory-compaction";
import { invalidId, memoryErrorResponse } from "../../entries";
import { memoryEntryCreateSchema } from "../../schema";

const KEY_FIELD: Record<MemoryScope, string> = {
  agent: "an agent",
  agent_subject: "a subject",
  custom: "an x-memory-key",
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) return invalidId();
  const parsed = await parseBody(req, memoryEntryCreateSchema);
  if ("error" in parsed) return parsed.error;

  const [store] = await db
    .select({
      scope: memoryStores.scope,
      ownerAgentId: memoryStores.ownerAgentId,
      memoryKey: memoryStores.memoryKey,
    })
    .from(memoryStores)
    .where(eq(memoryStores.id, id));
  if (!store)
    return Response.json({ error: "Memory store not found." }, { status: 404 });
  const scope = store.scope as MemoryScope;
  const { subjectId, content } = parsed.data;
  const partitionKey = memoryPartitionKey(scope, {
    agentId: store.ownerAgentId,
    subjectId: subjectId ?? null,
    memoryKey: store.memoryKey,
  });
  if (!partitionKey)
    return Response.json(
      { error: `An entry in this store needs ${KEY_FIELD[scope]}.` },
      { status: 400 },
    );

  try {
    const result = await applyMemoryOps(
      id,
      partitionKey,
      [{ op: "add", content }],
      { author: "human" },
    );
    scheduleCompaction([{ storeId: id, partitionKey }]);
    return Response.json({ partitionKey, ...result }, { status: 201 });
  } catch (err) {
    return memoryErrorResponse(err);
  }
}
