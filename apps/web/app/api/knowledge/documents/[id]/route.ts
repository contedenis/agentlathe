import { db, knowledgeDocuments } from "@agentlathe/db";
import { eq } from "drizzle-orm";
import { isUuid } from "@/lib/api-helpers";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id))
    return Response.json({ error: "Invalid id." }, { status: 400 });
  const [row] = await db
    .delete(knowledgeDocuments)
    .where(eq(knowledgeDocuments.id, id))
    .returning({ id: knowledgeDocuments.id });
  return row
    ? new Response(null, { status: 204 })
    : Response.json({ error: "Document not found." }, { status: 404 });
}
