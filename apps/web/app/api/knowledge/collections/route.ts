import { db, knowledgeCollections } from "@agentlathe/db";
import { dbErrorResponse, parseBody } from "@/lib/api-helpers";
import { listCollections } from "@/lib/queries-knowledge";
import { collectionCreateSchema } from "../schema";

export async function GET() {
  return Response.json(await listCollections());
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, collectionCreateSchema);
  if ("error" in parsed) return parsed.error;
  try {
    const [row] = await db
      .insert(knowledgeCollections)
      .values(parsed.data)
      .returning();
    return Response.json(row, { status: 201 });
  } catch (err) {
    return dbErrorResponse(err);
  }
}
