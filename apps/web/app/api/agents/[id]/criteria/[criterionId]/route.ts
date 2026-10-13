import { agentCriteria, db } from "@agentlathe/db";
import { and, eq } from "drizzle-orm";
import { dbErrorResponse, isUuid, parseBody } from "@/lib/api-helpers";
import {
  criterionUpdateSchema,
  thresholdOrderError,
  thresholdsInOrder,
} from "../schema";

type Params = { params: Promise<{ id: string; criterionId: string }> };

export async function PATCH(req: Request, { params }: Params) {
  const { id, criterionId } = await params;
  if (!isUuid(id) || !isUuid(criterionId))
    return Response.json({ error: "Invalid id." }, { status: 400 });

  const parsed = await parseBody(req, criterionUpdateSchema);
  if ("error" in parsed) return parsed.error;
  const changes = Object.fromEntries(
    Object.entries(parsed.data).filter(([, value]) => value !== undefined),
  ) as Partial<typeof agentCriteria.$inferInsert>;
  const where = and(
    eq(agentCriteria.id, criterionId),
    eq(agentCriteria.agentId, id),
  );

  try {
    const [current] = await db
      .select({
        failBelow: agentCriteria.failBelow,
        passAbove: agentCriteria.passAbove,
      })
      .from(agentCriteria)
      .where(where)
      .limit(1);
    if (!current)
      return Response.json({ error: "Criterion not found." }, { status: 404 });
    if (!thresholdsInOrder({ ...current, ...changes }))
      return Response.json({ error: thresholdOrderError }, { status: 400 });

    const [criterion] = await db
      .update(agentCriteria)
      .set({ ...changes, updatedAt: new Date() })
      .where(where)
      .returning();
    if (!criterion)
      return Response.json({ error: "Criterion not found." }, { status: 404 });
    return Response.json(criterion);
  } catch (err) {
    return dbErrorResponse(err);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id, criterionId } = await params;
  if (!isUuid(id) || !isUuid(criterionId))
    return Response.json({ error: "Invalid id." }, { status: 400 });

  const [row] = await db
    .delete(agentCriteria)
    .where(
      and(eq(agentCriteria.id, criterionId), eq(agentCriteria.agentId, id)),
    )
    .returning({ id: agentCriteria.id });
  if (!row)
    return Response.json({ error: "Criterion not found." }, { status: 404 });
  return new Response(null, { status: 204 });
}
