import { agents, db } from "@agentlathe/db";
import { eq } from "drizzle-orm";
import { dbErrorResponse, isUuid, parseBody } from "@/lib/api-helpers";
import { getAgentDetail } from "@/lib/queries";
import { replaceAgentRelations } from "../relations";
import { agentUpdateSchema } from "../schema";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id))
    return Response.json({ error: "Invalid id." }, { status: 400 });

  const agent = await getAgentDetail(id);
  if (!agent)
    return Response.json({ error: "Agent not found." }, { status: 404 });
  return Response.json(agent);
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id))
    return Response.json({ error: "Invalid id." }, { status: 400 });

  const parsed = await parseBody(req, agentUpdateSchema);
  if ("error" in parsed) return parsed.error;
  const { skillIds, toolIds, subAgentIds, mcpTools, ...agentFields } =
    parsed.data;

  if (subAgentIds?.includes(id)) {
    return Response.json(
      { error: "An agent cannot be its own sub-agent." },
      { status: 400 },
    );
  }

  try {
    const agent = await db.transaction(async (tx) => {
      let updated: typeof agents.$inferSelect | undefined;
      if (Object.keys(agentFields).length > 0) {
        [updated] = await tx
          .update(agents)
          .set({ ...agentFields, updatedAt: new Date() })
          .where(eq(agents.id, id))
          .returning();
      } else {
        [updated] = await tx
          .select()
          .from(agents)
          .where(eq(agents.id, id))
          .limit(1);
      }
      if (!updated) return null;

      await replaceAgentRelations(tx, id, {
        skillIds,
        toolIds,
        subAgentIds,
        mcpTools,
      });
      return updated;
    });

    if (!agent)
      return Response.json({ error: "Agent not found." }, { status: 404 });
    return Response.json(agent);
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

  const [row] = await db.delete(agents).where(eq(agents.id, id)).returning();
  if (!row)
    return Response.json({ error: "Agent not found." }, { status: 404 });
  return new Response(null, { status: 204 });
}
