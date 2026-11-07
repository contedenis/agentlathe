import { listMemoryEntryVersions } from "@agentlathe/db";
import { isUuid } from "@/lib/api-helpers";
import { entryNotFound, findEntry, invalidId } from "../../../../entries";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; entryId: string }> },
) {
  const { id, entryId } = await params;
  if (!isUuid(id) || !isUuid(entryId)) return invalidId();
  if (!(await findEntry(id, entryId))) return entryNotFound();
  return Response.json(await listMemoryEntryVersions(entryId));
}
