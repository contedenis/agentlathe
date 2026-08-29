import { agentRuns, db, fixDrafts } from "@agentlathe/db";
import { eq } from "drizzle-orm";
import { dbErrorResponse, isUuid, parseBody } from "@/lib/api-helpers";
import { fixDraftCreateSchema, toFixDrafts } from "@/lib/fix-drafts";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id))
    return Response.json({ error: "Invalid id." }, { status: 400 });

  const parsed = await parseBody(req, fixDraftCreateSchema);
  if ("error" in parsed) return parsed.error;

  try {
    const [run] = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.id, id))
      .limit(1);
    if (!run)
      return Response.json({ error: "Run not found." }, { status: 404 });

    const [row] = await db
      .insert(fixDrafts)
      .values({
        runId: id,
        messageId: parsed.data.messageId,
        anchor: parsed.data.anchor,
        category: parsed.data.category,
        rationale: parsed.data.rationale,
        proposedValue: parsed.data.proposedValue ?? null,
      })
      .returning();

    const [draft] = toFixDrafts([row]);
    return Response.json(draft, { status: 201 });
  } catch (err) {
    return dbErrorResponse(err);
  }
}
