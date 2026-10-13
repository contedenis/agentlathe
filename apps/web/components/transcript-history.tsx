import { isToolUIPart, type UIMessage } from "@agentlathe/runner/chat-ui";
import { MessageSquarePlusIcon } from "lucide-react";
import { ConversationEmptyState } from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Response } from "@/components/ai-elements/response";
import { FixDraftChip } from "@/components/fix-draft-chip";
import {
  type MessagePart,
  ToolCallDisplay,
  toolNameOf,
} from "@/components/tool-call-display";
import {
  anchorKey,
  type FixDraft,
  type FixDraftAnchor,
} from "@/lib/fix-drafts";
import { cn } from "@/lib/utils";

export type AnnotateTarget = {
  messageId: string;
  anchor: FixDraftAnchor;
  label: string;
  rationale?: string;
};

type AnnotateHooks = {
  registerRef?: (key: string, el: HTMLElement | null) => void;
  highlightedKey?: string | null;
  onAnnotate?: (target: AnnotateTarget) => void;
  draftsByAnchor?: Map<string, FixDraft[]>;
  onEditDraft?: (draft: FixDraft) => void;
};

export function AnnotateButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Note a fix: ${label}`}
      className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-2.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary"
    >
      <MessageSquarePlusIcon className="size-3" />
      Note a fix
    </button>
  );
}

function ToolCallPart({
  part,
  messageId,
  registerRef,
  highlightedKey,
  onAnnotate,
  draftsByAnchor,
  onEditDraft,
}: { part: MessagePart; messageId: string } & AnnotateHooks) {
  if (!isToolUIPart(part)) return null;

  const toolName = toolNameOf(part);
  const anchor: FixDraftAnchor = {
    type: "tool_call",
    toolCallId: part.toolCallId,
  };
  const key = anchorKey(messageId, anchor);
  const drafts = draftsByAnchor?.get(key) ?? [];

  return (
    <div
      ref={(el) => registerRef?.(key, el)}
      data-highlighted={highlightedKey === key || undefined}
      className="rounded-lg transition-shadow data-highlighted:ring-2 data-highlighted:ring-primary"
    >
      <ToolCallDisplay part={part} />
      {(drafts.length > 0 || onAnnotate) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {onEditDraft &&
            drafts.map((draft) => (
              <FixDraftChip
                key={draft.id}
                draft={draft}
                onClick={() => onEditDraft(draft)}
              />
            ))}
          {onAnnotate && (
            <AnnotateButton
              label={`Tool: ${toolName}`}
              onClick={() =>
                onAnnotate({ messageId, anchor, label: `Tool: ${toolName}` })
              }
            />
          )}
        </div>
      )}
    </div>
  );
}

export function TranscriptHistory({
  messages,
  registerRef,
  highlightedKey,
  onAnnotate,
  draftsByAnchor,
  onEditDraft,
}: { messages: UIMessage[] } & AnnotateHooks) {
  return (
    <div className="flex flex-col gap-5">
      {messages.length === 0 && (
        <ConversationEmptyState description="No transcript recorded for this run." />
      )}
      {messages.map((message, messageIndex) => {
        const stableId = message.id || `turn-${messageIndex}`;
        const turnAnchor: FixDraftAnchor = { type: "turn" };
        const turnKey = anchorKey(stableId, turnAnchor);
        const canAnnotateTurn = onAnnotate && message.role !== "user";
        const turnDrafts = draftsByAnchor?.get(turnKey) ?? [];

        return (
          <div
            key={stableId}
            ref={(el) => registerRef?.(turnKey, el)}
            data-highlighted={highlightedKey === turnKey || undefined}
            className={cn(
              "flex w-full max-w-[85%] flex-col gap-1.5 rounded-lg transition-shadow data-highlighted:ring-2 data-highlighted:ring-primary",
              message.role === "user" ? "ml-auto" : undefined,
            )}
          >
            <Message from={message.role} className="max-w-full">
              <MessageContent>
                {message.parts.map((part, index) => {
                  if (part.type === "text") {
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: text parts have no id and the array is persisted.
                      <Response key={`${stableId}-text-${index}`}>
                        {part.text}
                      </Response>
                    );
                  }
                  if (!isToolUIPart(part)) return null;
                  return (
                    <ToolCallPart
                      key={part.toolCallId}
                      part={part}
                      messageId={stableId}
                      registerRef={registerRef}
                      highlightedKey={highlightedKey}
                      onAnnotate={onAnnotate}
                      draftsByAnchor={draftsByAnchor}
                      onEditDraft={onEditDraft}
                    />
                  );
                })}
              </MessageContent>
            </Message>
            {(turnDrafts.length > 0 || canAnnotateTurn) && (
              <div className="flex flex-wrap items-center gap-2">
                {onEditDraft &&
                  turnDrafts.map((draft) => (
                    <FixDraftChip
                      key={draft.id}
                      draft={draft}
                      onClick={() => onEditDraft(draft)}
                    />
                  ))}
                {canAnnotateTurn && (
                  <AnnotateButton
                    label="Turn"
                    onClick={() =>
                      onAnnotate({
                        messageId: stableId,
                        anchor: turnAnchor,
                        label: "Assistant turn",
                      })
                    }
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
