import { agents, db } from "@agentlathe/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { dbErrorResponse, isUuid, parseBody } from "@/lib/api-helpers";
import { evaluateRecentRuns } from "@/lib/evaluations";

const evaluateRecentSchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id))
    return Response.json({ error: "Invalid id." }, { status: 400 });

  const parsed = await parseBody(req, evaluateRecentSchema, {
    allowEmpty: true,
  });
  if ("error" in parsed) return parsed.error;

  try {
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, id))
      .limit(1);
    if (!agent)
      return Response.json({ error: "Agent not found." }, { status: 404 });
    return Response.json(
      await evaluateRecentRuns(id, parsed.data.limit, req.signal),
    );
  } catch (err) {
    return dbErrorResponse(err);
  }
}
