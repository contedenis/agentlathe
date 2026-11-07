import { RUN_LABEL_MAX_LENGTH } from "@agentlathe/db/constants";
import {
  loadActiveAgent,
  safeValidateUIMessages,
  streamAgentForUI,
  type UIMessage,
} from "@agentlathe/runner";
import { z } from "zod";
import { isUuid, parseBody } from "@/lib/api-helpers";
import { createRecorder } from "@/lib/run-recorder";

const chatBodySchema = z.object({
  messages: z.array(z.unknown()),
  threadId: z.string().max(200).optional(),
  subjectId: z.string().trim().max(RUN_LABEL_MAX_LENGTH).optional(),
  memoryKey: z.string().trim().max(RUN_LABEL_MAX_LENGTH).optional(),
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
  const recorder = createRecorder({
    agent,
    source: "dashboard",
    threadId,
    subjectId: parsed.data.subjectId || null,
  });

  try {
    const response = await streamAgentForUI(agent, messages, {
      onTranscript: (input, output) => recorder.attachTranscript(input, output),
      abortSignal: req.signal,
      onRunEnd: (outcome) => recorder.record(outcome),
      run: {
        subjectId: parsed.data.subjectId || null,
        memoryKey: parsed.data.memoryKey || null,
      },
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
