import type {
  FinishReason,
  LanguageModelUsage,
  ModelMessage,
  TextStreamPart,
  ToolSet,
  TypedToolCall,
} from "ai";

type OpenAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type OpenAIChatCompletion = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

function mapFinishReason(reason: FinishReason): string {
  switch (reason) {
    case "tool-calls":
      return "tool_calls";
    case "length":
      return "length";
    case "content-filter":
      return "content_filter";
    default:
      return "stop";
  }
}

function toUsageBlock(usage: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}) {
  const prompt = usage.inputTokens ?? 0;
  const completion = usage.outputTokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage.totalTokens ?? prompt + completion,
  };
}

type CompletionResult = {
  text: string;
  toolCalls: Array<
    Pick<TypedToolCall<ToolSet>, "toolCallId" | "toolName"> & { input: unknown }
  >;
  toolResults: Array<{ toolCallId: string }>;
  usage: Pick<
    LanguageModelUsage,
    "inputTokens" | "outputTokens" | "totalTokens"
  >;
  finishReason: FinishReason;
  response: { id: string; timestamp: Date };
};

export function toOpenAIChatCompletion(
  result: CompletionResult,
  model: string,
  opts?: { id?: string; created?: number },
): OpenAIChatCompletion {
  const id = opts?.id ?? result.response.id;
  const created =
    opts?.created ?? Math.floor(result.response.timestamp.getTime() / 1000);

  // Only calls the model is still waiting on: one with a result already ran server-side,
  // and one the loop walked away from (denial, tool error) is not answerable either.
  const resolved = new Set(result.toolResults.map((r) => r.toolCallId));
  const finalCalls =
    result.finishReason === "tool-calls"
      ? result.toolCalls.filter((call) => !resolved.has(call.toolCallId))
      : [];

  const hasToolCalls = finalCalls.length > 0;
  const toolCalls: OpenAIToolCall[] | undefined = hasToolCalls
    ? finalCalls.map((call) => ({
        id: call.toolCallId,
        type: "function",
        function: {
          name: call.toolName,
          arguments: JSON.stringify(call.input),
        },
      }))
    : undefined;

  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: hasToolCalls ? result.text || null : result.text,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapFinishReason(result.finishReason),
      },
    ],
    usage: toUsageBlock(result.usage),
  };
}

function chunkFrame(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function errorFrame(error: unknown): {
  error: { message: string; type: string };
} {
  return {
    error: {
      message: error instanceof Error ? error.message : String(error),
      type: "api_error",
    },
  };
}

type PendingToolCall = {
  id: string;
  name: string;
  args: string;
  deltas: boolean;
};

const HEARTBEAT_MS = 15_000;

export function toOpenAIChatCompletionStream<TOOLS extends ToolSet>(
  fullStream: AsyncIterable<TextStreamPart<TOOLS>>,
  model: string,
  opts: {
    id: string;
    created: number;
    includeUsage?: boolean;
    heartbeatMs?: number;
  },
  onDone?: (result: {
    errored: boolean;
    error?: unknown;
  }) => void | Promise<void>,
  onCancel?: () => void,
): Response {
  const { id, created, includeUsage } = opts;
  const base = { id, object: "chat.completion.chunk" as const, created, model };
  // Buffered, never emitted on arrival: a later result means the server already ran it.
  const pending = new Map<string, PendingToolCall>();

  let doneRan = false;
  const runDone = async (result: { errored: boolean; error?: unknown }) => {
    if (doneRan) return;
    doneRan = true;
    await onDone?.(result);
  };

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stopHeartbeat = () => {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeat = undefined;
  };

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const emit = (chunk: unknown) =>
        controller.enqueue(encoder.encode(chunkFrame(chunk)));

      // SSE comments, ignored by OpenAI parsers: they hold the connection while tools run.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          stopHeartbeat();
        }
      }, opts.heartbeatMs ?? HEARTBEAT_MS);

      emit({
        ...base,
        choices: [
          { index: 0, delta: { role: "assistant" }, finish_reason: null },
        ],
      });

      let errored = false;
      let streamError: unknown;
      try {
        for await (const part of fullStream) {
          if (part.type === "error") {
            emit(errorFrame(part.error));
            errored = true;
            streamError = part.error;
            break;
          }
          switch (part.type) {
            case "text-delta":
              emit({
                ...base,
                choices: [
                  {
                    index: 0,
                    delta: { content: part.text },
                    finish_reason: null,
                  },
                ],
              });
              break;
            case "tool-input-start":
              pending.set(part.id, {
                id: part.id,
                name: part.toolName,
                args: "",
                deltas: false,
              });
              break;
            case "tool-input-delta": {
              const entry = pending.get(part.id);
              if (!entry) break;
              entry.args += part.delta;
              entry.deltas = true;
              break;
            }
            case "tool-call": {
              const entry = pending.get(part.toolCallId);
              if (!entry)
                pending.set(part.toolCallId, {
                  id: part.toolCallId,
                  name: part.toolName,
                  args: JSON.stringify(part.input),
                  deltas: false,
                });
              else if (!entry.deltas) entry.args = JSON.stringify(part.input);
              break;
            }
            case "tool-result":
            case "tool-error":
            case "tool-output-denied":
              pending.delete(part.toolCallId);
              break;
            case "finish": {
              // Same rule as the non-streaming half: resolved, errored and denied calls
              // already left `pending`, so what remains is what the model awaits.
              let index = 0;
              for (const call of pending.values()) {
                emit({
                  ...base,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index,
                            id: call.id,
                            type: "function",
                            function: { name: call.name, arguments: call.args },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                });
                index += 1;
              }
              emit({
                ...base,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: mapFinishReason(part.finishReason),
                  },
                ],
              });
              if (includeUsage)
                emit({
                  ...base,
                  choices: [],
                  usage: toUsageBlock(part.totalUsage),
                });
              break;
            }
          }
        }
      } catch (err) {
        try {
          emit(errorFrame(err));
        } catch {}
        errored = true;
        streamError = err;
      } finally {
        stopHeartbeat();
        try {
          if (!errored) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch {}
        await runDone({ errored, error: streamError });
      }
    },
    async cancel() {
      stopHeartbeat();
      onCancel?.();
      await runDone({ errored: false });
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

type OpenAIMessage = {
  role: string;
  content?: unknown;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof part === "object" &&
          part !== null &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join("");
  }
  return "";
}

export function openAIMessagesToModelMessages(
  messages: OpenAIMessage[],
): ModelMessage[] {
  const result: ModelMessage[] = [];
  const toolNameById = new Map<string, string>();

  for (const message of messages) {
    switch (message.role) {
      case "developer":
      case "system":
        result.push({ role: "system", content: extractText(message.content) });
        break;
      case "user":
        result.push({ role: "user", content: extractText(message.content) });
        break;
      case "assistant": {
        if (message.tool_calls && message.tool_calls.length > 0) {
          const text = extractText(message.content);
          const content: Exclude<AssistantMessage["content"], string> = [];
          if (text) content.push({ type: "text", text });
          for (const call of message.tool_calls) {
            toolNameById.set(call.id, call.function.name);
            content.push({
              type: "tool-call",
              toolCallId: call.id,
              toolName: call.function.name,
              input: safeJsonParse(call.function.arguments),
            });
          }
          result.push({ role: "assistant", content });
        } else {
          result.push({
            role: "assistant",
            content: extractText(message.content),
          });
        }
        break;
      }
      case "tool": {
        const toolCallId = message.tool_call_id ?? "";
        result.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId,
              toolName: toolNameById.get(toolCallId) ?? toolCallId,
              output: { type: "text", value: extractText(message.content) },
            },
          ],
        });
        break;
      }
    }
  }

  return result;
}

type AssistantMessage = Extract<ModelMessage, { role: "assistant" }>;

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
