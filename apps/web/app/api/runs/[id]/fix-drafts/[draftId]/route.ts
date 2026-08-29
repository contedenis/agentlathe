import { db, fixDrafts } from "@agentlathe/db";
import { and, eq } from "drizzle-orm";
import { dbErrorResponse, isUuid, parseBody } from "@/lib/api-helpers";
import { fixDraftUpdateSchema, toFixDrafts } from "@/lib/fix-drafts";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; draftId: string }> },
) {
  const { id, draftId } = await params;
  if (!isUuid(id) || !isUuid(draftId))
    return Response.json({ error: "Invalid id." }, { status: 400 });

  const parsed = await parseBody(req, fixDraftUpdateSchema);
  if ("error" in parsed) return parsed.error;

  const { status, category, rationale, proposedValue } = parsed.data;
  try {
    const [row] = await db
      .update(fixDrafts)
      .set({
        ...(status !== undefined && { status }),
        ...(category !== undefined && { category }),
        ...(rationale !== undefined && { rationale }),
        ...(proposedValue !== undefined && { proposedValue }),
      })
      .where(and(eq(fixDrafts.id, draftId), eq(fixDrafts.runId, id)))
      .returning();
    if (!row)
      return Response.json({ error: "Fix draft not found." }, { status: 404 });

    const [draft] = toFixDrafts([row]);
    return Response.json(draft);
  } catch (err) {
    return dbErrorResponse(err);
  }
}
