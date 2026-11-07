"use client";

import { isToolUIPart, type UIMessage } from "@agentlathe/runner/chat-ui";
import { useState } from "react";
import {
  deepParseJsonStrings,
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

type Passage = {
  collection: string;
  document: string;
  page: number | null;
  text: string;
};

function KnowledgeSearchOutput({
  input,
  output,
}: {
  input: unknown;
  output: unknown;
}) {
  const query = (deepParseJsonStrings(input) as { query?: unknown } | null)
    ?.query;
  const passages = (
    deepParseJsonStrings(output) as { passages?: Passage[] } | null
  )?.passages;
  if (
    typeof query !== "string" ||
    !Array.isArray(passages) ||
    passages.some((passage) => typeof passage?.text !== "string")
  )
    return <ToolOutput output={output} errorText={undefined} />;
  const numbered = passages.map((passage, index) => ({
    ...passage,
    number: index + 1,
  }));
  return (
    <div className="flex flex-col gap-3 p-4 text-sm">
      <p>
        <span className="text-muted-foreground">Searched for </span>
        {query}
      </p>
      {numbered.length === 0 ? (
        <p className="text-muted-foreground">
          Nothing in the collections matched.
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {numbered.map((passage) => (
            <li
              key={passage.number}
              className="flex flex-col gap-1 rounded-md border p-2"
            >
              <span className="font-mono text-xs text-muted-foreground">
                {passage.number}. {passage.collection} · {passage.document}
                {passage.page !== null && ` · page ${passage.page}`}
              </span>
              <span className="whitespace-pre-wrap">{passage.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
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
        {part.state === "output-available" &&
          (toolNameOf(part) === "search_knowledge" ? (
            <KnowledgeSearchOutput input={part.input} output={part.output} />
          ) : (
            <ToolOutput output={part.output} errorText={undefined} />
          ))}
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
