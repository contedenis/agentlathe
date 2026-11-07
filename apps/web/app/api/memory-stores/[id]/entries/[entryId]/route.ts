import { applyMemoryOps, setMemoryEntryPinned } from "@agentlathe/db";
import { isUuid, parseBody } from "@/lib/api-helpers";
import { scheduleCompaction } from "@/lib/memory-compaction";
import {
  entryNotFound,
  findEntry,
  invalidId,
  memoryErrorResponse,
} from "../../../entries";
import { memoryEntryUpdateSchema } from "../../../schema";

type Params = { params: Promise<{ id: string; entryId: string }> };

export async function PATCH(req: Request, { params }: Params) {
  const { id, entryId } = await params;
  if (!isUuid(id) || !isUuid(entryId)) return invalidId();
  const parsed = await parseBody(req, memoryEntryUpdateSchema);
  if ("error" in parsed) return parsed.error;
  const entry = await findEntry(id, entryId);
  if (!entry) return entryNotFound();

  if ("pinned" in parsed.data) {
    const row = await setMemoryEntryPinned(id, entryId, parsed.data.pinned);
    return row ? Response.json(row) : entryNotFound();
  }
  try {
    const result = await applyMemoryOps(
      id,
      entry.partitionKey,
      [{ op: "update", shortId: entry.shortId, content: parsed.data.content }],
      { author: "human" },
    );
    scheduleCompaction([{ storeId: id, partitionKey: entry.partitionKey }]);
    return Response.json(result);
  } catch (err) {
    return memoryErrorResponse(err);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id, entryId } = await params;
  if (!isUuid(id) || !isUuid(entryId)) return invalidId();
  const entry = await findEntry(id, entryId);
  if (!entry) return entryNotFound();
  try {
    await applyMemoryOps(
      id,
      entry.partitionKey,
      [{ op: "delete", shortId: entry.shortId }],
      { author: "human" },
    );
    return new Response(null, { status: 204 });
  } catch (err) {
    return memoryErrorResponse(err);
  }
}
