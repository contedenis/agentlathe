import { isToolUIPart, type UIMessage } from "@agentlathe/runner/chat-ui";
import { ArrowRightIcon } from "lucide-react";
import { toolNameOf } from "@/components/tool-call-display";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  anchorKey,
  FIX_DRAFT_CATEGORIES,
  FIX_DRAFT_CATEGORY_LABEL,
  type FixDraft,
} from "@/lib/fix-drafts";

function describeAnchor(messages: UIMessage[], draft: FixDraft): string {
  if (draft.anchor.type === "turn") return "Assistant turn";
  const toolCallId = draft.anchor.toolCallId;
  for (const message of messages) {
    for (const part of message.parts) {
      if (isToolUIPart(part) && part.toolCallId === toolCallId) {
        return `Tool: ${toolNameOf(part)}`;
      }
    }
  }
  return "Tool call";
}

const STATUS_LABEL: Record<FixDraft["status"], string> = {
  open: "Open",
  applied: "Applied",
  dismissed: "Dismissed",
};

function DraftCard({
  draft,
  messages,
  onStatusChange,
  onEdit,
  onPromote,
  onJumpTo,
}: {
  draft: FixDraft;
  messages: UIMessage[];
  onStatusChange: (draftId: string, status: FixDraft["status"]) => void;
  onEdit: (draft: FixDraft) => void;
  onPromote: (draft: FixDraft) => void;
  onJumpTo: (key: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge variant={draft.status === "open" ? "default" : "secondary"}>
          {STATUS_LABEL[draft.status]}
        </Badge>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-xs"
          onClick={() => onJumpTo(anchorKey(draft.messageId, draft.anchor))}
        >
          {describeAnchor(messages, draft)}
          <ArrowRightIcon className="size-3" />
        </Button>
      </div>
      <p className="text-sm break-words">{draft.rationale}</p>
      {draft.proposedValue && (
        <p className="rounded-lg bg-muted/50 p-2 text-xs text-muted-foreground">
          {draft.proposedValue}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {draft.status !== "applied" && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => onStatusChange(draft.id, "applied")}
          >
            Mark applied
          </Button>
        )}
        {draft.status !== "dismissed" && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => onStatusChange(draft.id, "dismissed")}
          >
            Dismiss
          </Button>
        )}
        {draft.status !== "open" && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => onStatusChange(draft.id, "open")}
          >
            Reopen
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => onEdit(draft)}
        >
          Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => onPromote(draft)}
        >
          Turn into criterion
        </Button>
      </div>
    </div>
  );
}

export function FixDraftsPanel({
  drafts,
  messages,
  onStatusChange,
  onEdit,
  onPromote,
  onJumpTo,
}: {
  drafts: FixDraft[];
  messages: UIMessage[];
  onStatusChange: (draftId: string, status: FixDraft["status"]) => void;
  onEdit: (draft: FixDraft) => void;
  onPromote: (draft: FixDraft) => void;
  onJumpTo: (key: string) => void;
}) {
  if (drafts.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        No notes yet. Use "Note a fix" on a turn or a tool call to record what
        you would change about the agent.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {FIX_DRAFT_CATEGORIES.map((category) => {
        const items = drafts.filter((draft) => draft.category === category);
        if (items.length === 0) return null;
        return (
          <div key={category} className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">
              {FIX_DRAFT_CATEGORY_LABEL[category]}{" "}
              <span className="text-muted-foreground">({items.length})</span>
            </h3>
            <div className="flex flex-col gap-2">
              {items.map((draft) => (
                <DraftCard
                  key={draft.id}
                  draft={draft}
                  messages={messages}
                  onStatusChange={onStatusChange}
                  onEdit={onEdit}
                  onPromote={onPromote}
                  onJumpTo={onJumpTo}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
