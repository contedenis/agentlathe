import { db, skills } from "@agentlathe/db";
import { eq } from "drizzle-orm";
import { dbErrorResponse, isUuid, parseBody } from "@/lib/api-helpers";
import { skillUpdateSchema } from "../schema";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id))
    return Response.json({ error: "Invalid id." }, { status: 400 });

  const [row] = await db
    .select()
    .from(skills)
    .where(eq(skills.id, id))
    .limit(1);
  if (!row)
    return Response.json({ error: "Skill not found." }, { status: 404 });
  return Response.json(row);
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id))
    return Response.json({ error: "Invalid id." }, { status: 400 });

  const parsed = await parseBody(req, skillUpdateSchema);
  if ("error" in parsed) return parsed.error;

  try {
    const [row] = await db
      .update(skills)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(skills.id, id))
      .returning();
    if (!row)
      return Response.json({ error: "Skill not found." }, { status: 404 });
    return Response.json(row);
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

  const [row] = await db.delete(skills).where(eq(skills.id, id)).returning();
  if (!row)
    return Response.json({ error: "Skill not found." }, { status: 404 });
  return new Response(null, { status: 204 });
}
