import { db, memoryStores } from "@agentlathe/db";
import { eq } from "drizzle-orm";
import { isUuid } from "@/lib/api-helpers";
import { getMemoryStore } from "@/lib/queries-memory";

const invalidId = () =>
  Response.json({ error: "Invalid id." }, { status: 400 });
const notFound = () =>
  Response.json({ error: "Memory store not found." }, { status: 404 });

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) return invalidId();
  const store = await getMemoryStore(id);
  return store ? Response.json(store) : notFound();
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) return invalidId();
  const [row] = await db
    .delete(memoryStores)
    .where(eq(memoryStores.id, id))
    .returning();
  return row ? new Response(null, { status: 204 }) : notFound();
}
