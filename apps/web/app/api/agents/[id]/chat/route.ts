import {
  createRunRecorder,
  loadActiveAgent,
  safeValidateUIMessages,
  streamAgentForUI,
  type UIMessage,
} from "@agentlathe/runner";
import { z } from "zod";
import { isUuid, parseBody } from "@/lib/api-helpers";

const chatBodySchema = z.object({
  messages: z.array(z.unknown()),
  threadId: z.string().max(200).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id))
    return Response.json({ error: "Invalid id." }, { status: 400 });

  const parsed = await parseBody(req, chatBodySchema);
  if ("error" in parsed) return parsed.error;

  const validated = await safeValidateUIMessages({
    messages: parsed.data.messages,
  });
  if (!validated.success)
    return Response.json(
      { error: "Invalid messages.", issues: validated.error.message },
      { status: 400 },
    );
  const messages = validated.data as UIMessage[];

  const agent = await loadActiveAgent(id);
  if (!agent)
    return Response.json(
      { error: "Agent not found or inactive." },
      { status: 404 },
    );

  // No thread row to look up: the id only groups runs and the client hands it back.
  const threadId = parsed.data.threadId ?? crypto.randomUUID();
  const recorder = createRunRecorder({ agent, source: "dashboard", threadId });

  try {
    const response = await streamAgentForUI(agent, messages, {
      onFinish: async ({ messages: turnMessages }) => {
        await recorder.attachTranscript(
          parsed.data.messages,
          (turnMessages as UIMessage[]).slice(parsed.data.messages.length),
        );
      },
      abortSignal: req.signal,
      onRunEnd: (outcome) => recorder.record(outcome),
    });

    const headers = new Headers(response.headers);
    headers.set("x-thread-id", threadId);
    return new Response(response.body, { status: response.status, headers });
  } catch (err) {
    console.error(err);
    return Response.json(
      { error: "The server had an error while processing your request." },
      { status: 500 },
    );
  }
}
