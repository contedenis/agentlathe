import { db, REVIEWED_VERDICTS, runEvaluations } from "@agentlathe/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { dbErrorResponse, isUuid, parseBody } from "@/lib/api-helpers";

const reviewSchema = z.object({
  reviewedVerdict: z.enum(REVIEWED_VERDICTS).nullable(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; evaluationId: string }> },
) {
  const { id, evaluationId } = await params;
  if (!isUuid(id) || !isUuid(evaluationId))
    return Response.json({ error: "Invalid id." }, { status: 400 });

  const parsed = await parseBody(req, reviewSchema);
  if ("error" in parsed) return parsed.error;

  try {
    const [evaluation] = await db
      .update(runEvaluations)
      .set({ reviewedVerdict: parsed.data.reviewedVerdict })
      .where(
        and(eq(runEvaluations.id, evaluationId), eq(runEvaluations.runId, id)),
      )
      .returning();
    if (!evaluation)
      return Response.json({ error: "Evaluation not found." }, { status: 404 });
    return Response.json(evaluation);
  } catch (err) {
    return dbErrorResponse(err);
  }
}
