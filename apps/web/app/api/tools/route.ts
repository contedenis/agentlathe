import { db, tools } from "@agentlathe/db";
import { dbErrorResponse, parseBody } from "@/lib/api-helpers";
import { toolCreateSchema } from "./schema";

export async function GET() {
  const rows = await db.select().from(tools);
  return Response.json(rows);
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, toolCreateSchema);
  if ("error" in parsed) return parsed.error;

  try {
    const [row] = await db.insert(tools).values(parsed.data).returning();
    return Response.json(row, { status: 201 });
  } catch (err) {
    return dbErrorResponse(err);
  }
}
