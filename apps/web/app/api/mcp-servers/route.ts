import { db, mcpServers } from "@agentlathe/db";
import { dbErrorResponse, parseBody } from "@/lib/api-helpers";
import {
  listMcpServers,
  mcpServerReturningColumns,
  redactMcpServer,
} from "@/lib/queries";
import { mcpServerCreateSchema } from "./schema";

export async function GET() {
  const rows = await listMcpServers();
  return Response.json(rows);
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, mcpServerCreateSchema);
  if ("error" in parsed) return parsed.error;

  try {
    const [row] = await db
      .insert(mcpServers)
      .values(parsed.data)
      .returning(mcpServerReturningColumns);
    return Response.json(redactMcpServer(row), { status: 201 });
  } catch (err) {
    return dbErrorResponse(err);
  }
}
