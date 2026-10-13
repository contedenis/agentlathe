import type { UIMessage } from "@agentlathe/runner/chat-ui";

type MessagePart = UIMessage["parts"][number];
type AnyRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is AnyRecord =>
  typeof value === "object" && value !== null;

const MODEL_OUTPUT_TYPES = new Set([
  "text",
  "json",
  "content",
  "error-text",
  "error-json",
  "execution-denied",
]);
const MODEL_OUTPUT_KEYS = new Set([
  "type",
  "value",
  "reason",
  "providerOptions",
]);

function textPart(text: string): MessagePart {
  return { type: "text", text };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) =>
      typeof item === "string"
        ? item
        : isRecord(item) && typeof item.text === "string"
          ? item.text
          : "",
    )
    .join("");
}

function isModelOutput(output: unknown): output is AnyRecord {
  return (
    isRecord(output) &&
    typeof output.type === "string" &&
    MODEL_OUTPUT_TYPES.has(output.type) &&
    Object.keys(output).every((key) => MODEL_OUTPUT_KEYS.has(key))
  );
}

// Outputs live in a separate `tool` message: collected first so a call renders with its result.
function collectToolOutputs(messages: unknown[]): Map<string, unknown> {
  const outputs = new Map<string, unknown>();
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (message.role === "tool" && typeof message.tool_call_id === "string") {
      outputs.set(message.tool_call_id, textOf(message.content));
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== "tool-result") continue;
      if (typeof part.toolCallId !== "string") continue;
      outputs.set(part.toolCallId, part.output ?? part.result);
    }
  }
  return outputs;
}

function resultState(output: unknown) {
  if (output === undefined) return { state: "input-available" };
  if (!isModelOutput(output)) return { state: "output-available", output };
  if (output.type === "execution-denied")
    return {
      state: "output-denied",
      approval: {
        id: "",
        approved: false,
        ...(typeof output.reason === "string" && { reason: output.reason }),
      },
    };
  if (output.type === "error-text" || output.type === "error-json")
    return {
      state: "output-error",
      errorText:
        typeof output.value === "string"
          ? output.value
          : JSON.stringify(output.value),
    };
  return { state: "output-available", output: output.value };
}

function toolPart(part: AnyRecord, outputs: Map<string, unknown>): MessagePart {
  const toolCallId = String(part.toolCallId ?? "");
  return {
    type: `tool-${part.toolName ?? "unknown"}`,
    toolCallId,
    input: part.input ?? part.args,
    ...resultState(outputs.get(toolCallId)),
  } as MessagePart;
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function openAIToolParts(toolCalls: unknown, outputs: Map<string, unknown>) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.filter(isRecord).map((call) => {
    const fn = isRecord(call.function) ? call.function : {};
    return toolPart(
      {
        toolCallId: call.id,
        toolName: fn.name,
        input: parseArguments(fn.arguments),
      },
      outputs,
    );
  });
}

function partsOf(content: unknown, outputs: Map<string, unknown>) {
  if (typeof content === "string") return content ? [textPart(content)] : [];
  if (!Array.isArray(content)) return [];

  const parts: MessagePart[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(textPart(item));
      continue;
    }
    if (!isRecord(item)) continue;
    if (item.type === "text" && typeof item.text === "string")
      parts.push(textPart(item.text));
    else if (item.type === "tool-call") parts.push(toolPart(item, outputs));
  }
  return parts;
}

// Ids are synthesized by position, which is stable because a transcript never changes.
export function toTranscriptMessages(
  value: unknown,
  idPrefix: string,
): UIMessage[] {
  if (!Array.isArray(value)) return [];
  const outputs = collectToolOutputs(value);

  return value.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const rawRole = typeof item.role === "string" ? item.role : "assistant";
    if (rawRole === "tool") return [];
    const role = rawRole === "developer" ? "system" : rawRole;

    const id =
      typeof item.id === "string" && item.id ? item.id : `${idPrefix}-${index}`;
    const parts = Array.isArray(item.parts)
      ? (item.parts.filter(isRecord) as MessagePart[])
      : [
          ...partsOf(item.content, outputs),
          ...openAIToolParts(item.tool_calls, outputs),
        ];
    if (parts.length === 0) return [];

    return [{ id, role, parts } as UIMessage];
  });
}
