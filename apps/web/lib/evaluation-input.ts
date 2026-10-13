import type { UIMessage } from "@agentlathe/runner/chat-ui";
import { toTranscriptMessages } from "./transcript";

type AnyRecord = Record<string, unknown>;

export type EvaluationInput = { state: string } | { awaitingApproval: true };

export const EARLIER_HEADER =
  "=== EARLIER CONVERSATION (context only, already evaluated) ===";
export const THIS_RUN_HEADER = "=== THIS RUN (evaluate this) ===";
const EARLIER_OMITTED = "…[earlier messages omitted]";
const EARLIER_CAP = 6000;
const TOOL_TEXT_CAP = 2000;
const DENIED = "DENIED by the user";
const PAUSED = "PAUSED: waiting for human approval (run ended here)";

const isRecord = (value: unknown): value is AnyRecord =>
  typeof value === "object" && value !== null;

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value) ?? String(value);
}

function cap(text: string): string {
  if (text.length <= TOOL_TEXT_CAP) return text;
  return `${text.slice(0, TOOL_TEXT_CAP)} …[truncated ${text.length - TOOL_TEXT_CAP} chars]`;
}

function isToolPart(part: AnyRecord): boolean {
  return (
    typeof part.type === "string" &&
    (part.type.startsWith("tool-") || part.type === "dynamic-tool")
  );
}

function renderResult(part: AnyRecord): string {
  const approval = isRecord(part.approval) ? part.approval : undefined;
  switch (part.state) {
    case "output-available":
      return cap(asText(part.output));
    case "output-error":
      return `ERROR: ${cap(asText(part.errorText))}`;
    case "output-denied":
      return DENIED;
    case "approval-requested":
      return PAUSED;
    default:
      return approval?.approved === false ? DENIED : "(no result)";
  }
}

function toolLine(part: AnyRecord): string {
  const name =
    part.type === "dynamic-tool"
      ? asText(part.toolName)
      : String(part.type).slice("tool-".length);
  return `TOOL CALL ${name}(${cap(asText(part.input ?? {}))}) -> ${renderResult(part)}`;
}

function partsOf(message: UIMessage): AnyRecord[] {
  return (message.parts as unknown[]).filter(isRecord);
}

function linesOf(messages: UIMessage[], { userOnly = false } = {}): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (userOnly && message.role !== "user") continue;
    const role = message.role.toUpperCase();
    for (const part of partsOf(message)) {
      if (part.type === "text" && typeof part.text === "string") {
        if (part.text.trim()) lines.push(`${role}: ${part.text}`);
      } else if (isToolPart(part)) {
        lines.push(toolLine(part));
      }
    }
  }
  return lines;
}

function capEarlier(lines: string[]): string[] {
  const kept = [...lines];
  let length = kept.join("\n").length;
  while (length > EARLIER_CAP && kept.length > 1) {
    length -= (kept.shift()?.length ?? 0) + 1;
  }
  if (kept.length === lines.length && length <= EARLIER_CAP) return kept;
  const last = kept.length === 1 ? kept[0].slice(-EARLIER_CAP) : undefined;
  return [EARLIER_OMITTED, ...(last === undefined ? kept : [last])];
}

export function evaluationInput(
  input: unknown,
  output: unknown,
): EvaluationInput {
  const inputMessages = toTranscriptMessages(input, "in");
  const outputMessages = toTranscriptMessages(output, "out");

  const final = [...inputMessages, ...outputMessages].at(-1);
  if (
    final?.role === "assistant" &&
    partsOf(final).some(
      (part) => isToolPart(part) && part.state === "approval-requested",
    )
  )
    return { awaitingApproval: true };

  const lastUser = inputMessages.findLastIndex(
    (message) => message.role === "user",
  );
  const earlier = linesOf(inputMessages.slice(0, Math.max(lastUser, 0)), {
    userOnly: true,
  });
  const current = linesOf([
    ...inputMessages.slice(Math.max(lastUser, 0)),
    ...outputMessages,
  ]);

  return {
    state: [
      ...(earlier.length ? [EARLIER_HEADER, ...capEarlier(earlier), ""] : []),
      THIS_RUN_HEADER,
      ...current,
    ].join("\n"),
  };
}
