import {
  agentCriteria,
  agentRuns,
  agents,
  db,
  fixDrafts,
} from "@agentlathe/db";
import { and, asc, eq } from "drizzle-orm";
import { dbErrorResponse, isUuid, parseBody } from "@/lib/api-helpers";
import { criterionCreateSchema } from "./schema";

async function agentExists(id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1);
  return Boolean(row);
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id))
    return Response.json({ error: "Invalid id." }, { status: 400 });

  const [exists, criteria] = await Promise.all([
    agentExists(id),
    db
      .select()
      .from(agentCriteria)
      .where(eq(agentCriteria.agentId, id))
      .orderBy(asc(agentCriteria.createdAt)),
  ]);
  if (!exists)
    return Response.json({ error: "Agent not found." }, { status: 404 });
  return Response.json(criteria);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id))
    return Response.json({ error: "Invalid id." }, { status: 400 });

  const parsed = await parseBody(req, criterionCreateSchema);
  if ("error" in parsed) return parsed.error;
  const { sourceFixDraftId, ...fields } = parsed.data;

  try {
    const [exists, sourceDraft] = await Promise.all([
      agentExists(id),
      sourceFixDraftId
        ? db
            .select({ id: fixDrafts.id })
            .from(fixDrafts)
            .innerJoin(agentRuns, eq(agentRuns.id, fixDrafts.runId))
            .where(
              and(
                eq(fixDrafts.id, sourceFixDraftId),
                eq(agentRuns.agentId, id),
              ),
            )
            .limit(1)
            .then(([row]) => row)
        : undefined,
    ]);
    if (!exists)
      return Response.json({ error: "Agent not found." }, { status: 404 });
    if (sourceFixDraftId && !sourceDraft)
      return Response.json(
        { error: "The source fix draft does not belong to this agent." },
        { status: 400 },
      );

    const [criterion] = await db
      .insert(agentCriteria)
      .values({ ...fields, agentId: id, sourceFixDraftId })
      .returning();
    return Response.json(criterion, { status: 201 });
  } catch (err) {
    return dbErrorResponse(err);
  }
}
