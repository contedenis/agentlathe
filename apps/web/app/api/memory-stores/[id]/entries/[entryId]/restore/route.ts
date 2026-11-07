import { applyMemoryOps } from "@agentlathe/db";
import { isUuid, parseBody } from "@/lib/api-helpers";
import {
  entryNotFound,
  findEntry,
  invalidId,
  memoryErrorResponse,
} from "../../../../entries";
import { memoryEntryRestoreSchema } from "../../../../schema";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; entryId: string }> },
) {
  const { id, entryId } = await params;
  if (!isUuid(id) || !isUuid(entryId)) return invalidId();
  const parsed = await parseBody(req, memoryEntryRestoreSchema);
  if ("error" in parsed) return parsed.error;
  const entry = await findEntry(id, entryId);
  if (!entry) return entryNotFound();
  try {
    return Response.json(
      await applyMemoryOps(
        id,
        entry.partitionKey,
        [
          {
            op: "restore",
            shortId: entry.shortId,
            versionId: parsed.data.versionId,
          },
        ],
        { author: "human" },
      ),
    );
  } catch (err) {
    return memoryErrorResponse(err);
  }
}
