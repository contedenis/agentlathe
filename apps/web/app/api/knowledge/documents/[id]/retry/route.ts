import { db, knowledgeDocuments } from "@agentlathe/db";
import { and, eq, sql } from "drizzle-orm";
import { isUuid } from "@/lib/api-helpers";
import { scheduleKnowledgeProcessing } from "@/lib/knowledge/engine";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id))
    return Response.json({ error: "Invalid id." }, { status: 400 });
  const [row] = await db
    .update(knowledgeDocuments)
    .set({
      status: "pending",
      attempts: 0,
      error: null,
      claimedAt: null,
      claimId: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(knowledgeDocuments.id, id),
        eq(knowledgeDocuments.status, "failed"),
      ),
    )
    .returning({ id: knowledgeDocuments.id });
  if (!row) {
    const [exists] = await db
      .select({ id: knowledgeDocuments.id })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, id));
    return exists
      ? Response.json(
          { error: "Only a document that failed can be retried." },
          { status: 409 },
        )
      : Response.json({ error: "Document not found." }, { status: 404 });
  }
  scheduleKnowledgeProcessing();
  return Response.json({ id: row.id, status: "pending" });
}
