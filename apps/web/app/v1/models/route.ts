import { agents, db } from "@agentlathe/db";
import { eq } from "drizzle-orm";

export async function GET() {
  const rows = await db
    .select({ slug: agents.slug, createdAt: agents.createdAt })
    .from(agents)
    .where(eq(agents.isActive, true));

  return Response.json({
    object: "list",
    data: rows.map((row) => ({
      id: row.slug,
      object: "model",
      created: Math.floor((row.createdAt ?? new Date()).getTime() / 1000),
      owned_by: "agentlathe",
    })),
  });
}
