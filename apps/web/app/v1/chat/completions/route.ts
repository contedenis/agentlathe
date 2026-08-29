import {
  type AgentRow,
  buildAgentRuntime,
  buildHeadlessToolApproval,
  createRunRecorder,
  loadActiveAgent,
  openAIMessagesToModelMessages,
  toOpenAIChatCompletion,
  toOpenAIChatCompletionStream,
} from "@agentlathe/runner";
import { z } from "zod";

const requestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.object({ role: z.string() }).passthrough()).min(1),
  stream: z.boolean().optional(),
  stream_options: z
    .object({ include_usage: z.boolean().optional() })
    .optional(),
});

function errorResponse(
  message: string,
  type: string,
  status: number,
): Response {
  return Response.json({ error: { message, type } }, { status });
}

export async function POST(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return errorResponse(
      "Invalid JSON in request body.",
      "invalid_request_error",
      400,
    );
  }

  const parsed = requestSchema.safeParse(json);
  if (!parsed.success) {
    return errorResponse(
      parsed.error.issues[0]?.message ?? "Invalid request body.",
      "invalid_request_error",
      400,
    );
  }
  const body = parsed.data;

  let messages: ReturnType<typeof openAIMessagesToModelMessages>;
  try {
    messages = openAIMessagesToModelMessages(body.messages);
  } catch (err) {
    return errorResponse(
      err instanceof Error ? err.message : "Invalid messages.",
      "invalid_request_error",
      400,
    );
  }

  let runtime: Awaited<ReturnType<typeof buildAgentRuntime>>["agent"];
  let cleanup: Awaited<ReturnType<typeof buildAgentRuntime>>["cleanup"];
  let stats: Awaited<ReturnType<typeof buildAgentRuntime>>["stats"];
  let agent: AgentRow;
  try {
    const found = await loadActiveAgent(body.model);
    if (!found) {
      return errorResponse(
        `Model '${body.model}' not found`,
        "invalid_request_error",
        404,
      );
    }
    agent = found;

    ({
      agent: runtime,
      cleanup,
      stats,
    } = await buildAgentRuntime(agent, {
      buildApproval: buildHeadlessToolApproval,
    }));
  } catch (err) {
    console.error(err);
    return errorResponse(
      "The server had an error while processing your request.",
      "api_error",
      500,
    );
  }

  const threadId = req.headers.get("x-thread-id")?.slice(0, 200) || null;
  const recorder = createRunRecorder({ agent, source: "v1", threadId });

  if (body.stream) {
    const abort = new AbortController();
    if (req.signal.aborted) abort.abort();
    else
      req.signal.addEventListener("abort", () => abort.abort(), { once: true });
    try {
      const result = await runtime.stream({
        messages,
        abortSignal: abort.signal,
      });
      return toOpenAIChatCompletionStream(
        result.fullStream,
        body.model,
        {
          id: `chatcmpl-${crypto.randomUUID()}`,
          created: Math.floor(Date.now() / 1000),
          includeUsage: body.stream_options?.include_usage ?? false,
        },
        // Fired by the serializer's onDone: cleaning up earlier kills the MCP clients mid-stream.
        async ({ error }) => {
          await cleanup();
          const steps = await Promise.resolve(result.steps).catch(() => []);
          await recorder.record({ stats: stats(), error });
          await recorder.attachTranscript(
            body.messages,
            steps.flatMap((step) => step.response.messages),
          );
        },
        () => abort.abort(),
      );
    } catch (err) {
      console.error(err);
      await cleanup();
      await recorder.record({ stats: stats(), error: err });
      await recorder.attachTranscript(body.messages, []);
      return errorResponse(
        "The server had an error while processing your request.",
        "api_error",
        500,
      );
    }
  }

  try {
    const result = await runtime.generate({
      messages,
      abortSignal: req.signal,
    });
    await recorder.record({ stats: stats() });
    await recorder.attachTranscript(
      body.messages,
      result.steps.flatMap((step) => step.response.messages),
    );
    return Response.json(toOpenAIChatCompletion(result, body.model));
  } catch (err) {
    console.error(err);
    await recorder.record({ stats: stats(), error: err });
    await recorder.attachTranscript(body.messages, []);
    return errorResponse(
      "The server had an error while processing your request.",
      "api_error",
      500,
    );
  } finally {
    await cleanup();
  }
}
