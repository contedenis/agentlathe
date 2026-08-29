"use client";

import { isToolUIPart, type UIMessage } from "@agentlathe/runner/chat-ui";
import { useState } from "react";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  toolPreview,
} from "@/components/ai-elements/tool";

export type MessagePart = UIMessage["parts"][number];

export function toolNameOf(part: MessagePart): string {
  if (!isToolUIPart(part)) return "";
  return part.type === "dynamic-tool" ? part.toolName : part.type.slice(5);
}

function needsAttention(part: MessagePart): boolean {
  return (
    isToolUIPart(part) &&
    (part.state === "approval-requested" ||
      part.state === "output-error" ||
      part.state === "output-denied")
  );
}

export function ToolCallDisplay({ part }: { part: MessagePart }) {
  // Frozen at mount: the Collapsible is uncontrolled, and Base UI warns if its
  // default changes when the part transitions (approval-requested → responded).
  const [defaultOpen] = useState(() => needsAttention(part));
  if (!isToolUIPart(part)) return null;

  return (
    <Tool state={part.state} defaultOpen={defaultOpen}>
      <ToolHeader
        type={part.type}
        state={part.state}
        title={toolNameOf(part)}
        preview={toolPreview(part)}
      />
      <ToolContent>
        {(part.state === "input-streaming" ||
          part.state === "input-available" ||
          part.state === "approval-requested") && (
          <ToolInput input={part.input} />
        )}
        {part.state === "output-available" && (
          <ToolOutput output={part.output} errorText={undefined} />
        )}
        {part.state === "output-error" && (
          <ToolOutput output={undefined} errorText={part.errorText} />
        )}
        {part.state === "output-denied" && part.approval.reason && (
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            {part.approval.reason}
          </p>
        )}
      </ToolContent>
    </Tool>
  );
}
