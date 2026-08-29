import { db, skills } from "@agentlathe/db";
import { dbErrorResponse, parseBody } from "@/lib/api-helpers";
import { skillCreateSchema } from "./schema";

export async function GET() {
  const rows = await db.select().from(skills);
  return Response.json(rows);
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, skillCreateSchema);
  if ("error" in parsed) return parsed.error;

  try {
    const [row] = await db.insert(skills).values(parsed.data).returning();
    return Response.json(row, { status: 201 });
  } catch (err) {
    return dbErrorResponse(err);
  }
}
