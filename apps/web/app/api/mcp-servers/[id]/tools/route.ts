import { db, mcpServers } from "@agentlathe/db";
import { discoverMcpTools } from "@agentlathe/runner";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { isUuid, mcpConnectionErrorResponse } from "@/lib/api-helpers";

// Lets "test with saved credentials" test the URL in the form, not the stored one.
const bodySchema = z.object({ serverUrl: z.url().optional() });

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id))
    return Response.json({ error: "Invalid id." }, { status: 400 });

  const rawBody = await req.text();
  let serverUrlOverride: string | undefined;
  if (rawBody) {
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return Response.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success)
      return Response.json({ error: "Invalid serverUrl." }, { status: 400 });
    serverUrlOverride = parsed.data.serverUrl;
  }

  const [server] = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.id, id))
    .limit(1);
  if (!server) {
    return Response.json({ error: "MCP server not found." }, { status: 404 });
  }

  const serverUrl = serverUrlOverride ?? server.serverUrl;
  try {
    const tools = await discoverMcpTools({ ...server, serverUrl });
    return Response.json({ tools });
  } catch (err) {
    return mcpConnectionErrorResponse(serverUrl, err);
  }
}
