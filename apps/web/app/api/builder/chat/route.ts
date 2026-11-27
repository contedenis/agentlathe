import { getSettings } from "@agentlathe/db";
import { safeValidateUIMessages, type UIMessage } from "@agentlathe/runner";
import { streamBuilderForUI } from "@agentlathe/runner/builder";
import { z } from "zod";
import { isUuid, parseBody } from "@/lib/api-helpers";
import { loadAgentContext } from "@/lib/builder/agent-context";
import { loadBuilderCatalog } from "@/lib/builder/catalog";
import { builderInstructions } from "@/lib/builder/instructions";
import { buildBuilderTools } from "@/lib/builder/tools";

const chatBodySchema = z.object({
  messages: z.array(z.unknown()),
  agentId: z.string().refine(isUuid).optional(),
});

const UNFINISHED = new Set(["input-streaming", "input-available"]);

function withoutUnfinishedToolCalls(messages: UIMessage[]): UIMessage[] {
  return messages
    .map((message) => ({
      ...message,
      parts: message.parts.filter(
        (part) => !("state" in part && UNFINISHED.has(String(part.state))),
      ),
    }))
    .filter((message) => message.parts.length > 0);
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, chatBodySchema);
  if ("error" in parsed) return parsed.error;
  const { agentId } = parsed.data;

  const validated = await safeValidateUIMessages({
    messages: parsed.data.messages,
  });
  if (!validated.success)
    return Response.json(
      { error: "Invalid messages.", issues: validated.error.message },
      { status: 400 },
    );

  const [{ builderModel }, catalog, agent] = await Promise.all([
    getSettings(),
    loadBuilderCatalog(agentId),
    agentId ? loadAgentContext(agentId) : null,
  ]);
  if (!builderModel)
    return Response.json(
      { error: "Choose a builder model in Settings first." },
      { status: 409 },
    );
  if (agentId && !agent)
    return Response.json({ error: "Agent not found." }, { status: 404 });

  return streamBuilderForUI({
    model: builderModel,
    instructions: builderInstructions(catalog, agent),
    tools: buildBuilderTools(catalog, agent),
    messages: withoutUnfinishedToolCalls(validated.data as UIMessage[]),
    abortSignal: req.signal,
  });
}
