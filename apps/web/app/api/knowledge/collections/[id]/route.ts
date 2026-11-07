import { db, knowledgeCollections } from "@agentlathe/db";
import { eq } from "drizzle-orm";
import { dbErrorResponse, isUuid, parseBody } from "@/lib/api-helpers";
import { getCollection } from "@/lib/queries-knowledge";
import { collectionUpdateSchema } from "../../schema";

const notFound = () =>
  Response.json({ error: "Collection not found." }, { status: 404 });

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id))
    return Response.json({ error: "Invalid id." }, { status: 400 });
  const collection = await getCollection(id);
  return collection ? Response.json(collection) : notFound();
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id))
    return Response.json({ error: "Invalid id." }, { status: 400 });
  const parsed = await parseBody(req, collectionUpdateSchema);
  if ("error" in parsed) return parsed.error;
  try {
    const [row] = await db
      .update(knowledgeCollections)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(knowledgeCollections.id, id))
      .returning();
    return row ? Response.json(row) : notFound();
  } catch (err) {
    return dbErrorResponse(err);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id))
    return Response.json({ error: "Invalid id." }, { status: 400 });
  const [row] = await db
    .delete(knowledgeCollections)
    .where(eq(knowledgeCollections.id, id))
    .returning({ id: knowledgeCollections.id });
  return row ? new Response(null, { status: 204 }) : notFound();
}
