import { discoverMcpTools } from "@agentlathe/runner";
import { z } from "zod";
import { mcpConnectionErrorResponse, parseBody } from "@/lib/api-helpers";
import { authConfigSchema } from "../schema";

const testSchema = z.object({
  serverUrl: z.url(),
  authConfig: authConfigSchema,
});

export async function POST(req: Request) {
  const parsed = await parseBody(req, testSchema);
  if ("error" in parsed) return parsed.error;

  try {
    const tools = await discoverMcpTools(parsed.data);
    return Response.json({ tools });
  } catch (err) {
    return mcpConnectionErrorResponse(parsed.data.serverUrl, err);
  }
}
