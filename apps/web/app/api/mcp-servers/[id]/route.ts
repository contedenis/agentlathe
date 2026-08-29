import { db, mcpServers } from "@agentlathe/db";
import { eq } from "drizzle-orm";
import { dbErrorResponse, isUuid, parseBody } from "@/lib/api-helpers";
import {
  getMcpServer,
  mcpServerReturningColumns,
  redactMcpServer,
} from "@/lib/queries";
import { mcpServerUpdateSchema } from "../schema";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id))
    return Response.json({ error: "Invalid id." }, { status: 400 });

  const row = await getMcpServer(id);
  if (!row)
    return Response.json({ error: "MCP server not found." }, { status: 404 });
  return Response.json(row);
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id))
    return Response.json({ error: "Invalid id." }, { status: 400 });

  const parsed = await parseBody(req, mcpServerUpdateSchema);
  if ("error" in parsed) return parsed.error;

  try {
    const [row] = await db
      .update(mcpServers)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(mcpServers.id, id))
      .returning(mcpServerReturningColumns);
    if (!row)
      return Response.json({ error: "MCP server not found." }, { status: 404 });
    return Response.json(redactMcpServer(row));
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

  const [row] = await db
    .delete(mcpServers)
    .where(eq(mcpServers.id, id))
    .returning();
  if (!row)
    return Response.json({ error: "MCP server not found." }, { status: 404 });
  return new Response(null, { status: 204 });
}
