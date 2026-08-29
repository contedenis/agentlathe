import { agentSlug, agents, db } from "@agentlathe/db";
import { dbErrorResponse, parseBody } from "@/lib/api-helpers";
import { replaceAgentRelations } from "./relations";
import { agentCreateSchema } from "./schema";

export async function GET() {
  const rows = await db.select().from(agents);
  return Response.json(rows);
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, agentCreateSchema);
  if ("error" in parsed) return parsed.error;
  const { skillIds, toolIds, subAgentIds, mcpTools, ...agentFields } =
    parsed.data;
  const slug = agentFields.slug ?? agentSlug(agentFields.name);

  try {
    const agent = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(agents)
        .values({ ...agentFields, slug })
        .returning();
      await replaceAgentRelations(tx, created.id, {
        skillIds,
        toolIds,
        subAgentIds,
        mcpTools,
      });
      return created;
    });
    return Response.json(agent, { status: 201 });
  } catch (err) {
    return dbErrorResponse(err);
  }
}
