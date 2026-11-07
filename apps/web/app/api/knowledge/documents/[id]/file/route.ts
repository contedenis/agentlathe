import { db, knowledgeDocuments, knowledgeFiles } from "@agentlathe/db";
import { eq } from "drizzle-orm";
import { isUuid } from "@/lib/api-helpers";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id))
    return Response.json({ error: "Invalid id." }, { status: 400 });
  const [file] = await db
    .select({
      filename: knowledgeDocuments.filename,
      mediaType: knowledgeDocuments.mediaType,
      bytes: knowledgeFiles.bytes,
    })
    .from(knowledgeFiles)
    .innerJoin(
      knowledgeDocuments,
      eq(knowledgeDocuments.id, knowledgeFiles.documentId),
    )
    .where(eq(knowledgeFiles.documentId, id));
  if (!file)
    return Response.json({ error: "Document not found." }, { status: 404 });
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      "content-type":
        file.mediaType === "application/pdf"
          ? "application/pdf"
          : `${file.mediaType}; charset=utf-8`,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "x-content-type-options": "nosniff",
    },
  });
}
