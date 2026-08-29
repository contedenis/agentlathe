import type { UIMessage } from "@agentlathe/runner/chat-ui";

type MessagePart = UIMessage["parts"][number];
type AnyRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is AnyRecord =>
  typeof value === "object" && value !== null;

function textPart(text: string): MessagePart {
  return { type: "text", text };
}

// Outputs live in a separate `tool` message: collected first so a call renders with its result.
function collectToolOutputs(messages: unknown[]): Map<string, unknown> {
  const outputs = new Map<string, unknown>();
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== "tool-result") continue;
      if (typeof part.toolCallId !== "string") continue;
      outputs.set(part.toolCallId, part.output ?? part.result);
    }
  }
  return outputs;
}

function toolPart(part: AnyRecord, outputs: Map<string, unknown>): MessagePart {
  const toolCallId = String(part.toolCallId ?? "");
  const output = outputs.get(toolCallId);
  return {
    type: `tool-${part.toolName ?? "unknown"}`,
    toolCallId,
    input: part.input ?? part.args,
    ...(output === undefined
      ? { state: "input-available" }
      : { state: "output-available", output }),
  } as MessagePart;
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
    const role = typeof item.role === "string" ? item.role : "assistant";
    if (role === "tool") return [];

    const id =
      typeof item.id === "string" && item.id ? item.id : `${idPrefix}-${index}`;
    const parts = Array.isArray(item.parts)
      ? (item.parts as MessagePart[])
      : partsOf(item.content, outputs);
    if (parts.length === 0) return [];

    return [{ id, role, parts } as UIMessage];
  });
}
