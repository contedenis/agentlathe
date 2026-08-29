"use client";

import { isToolUIPart, type UIMessage } from "@agentlathe/runner/chat-ui";
import { CheckIcon, ChevronDownIcon, CopyIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { FixDraftDialog } from "@/components/fix-draft-dialog";
import { FixDraftsPanel } from "@/components/fix-drafts-panel";
import {
  type AnnotateTarget,
  TranscriptHistory,
} from "@/components/transcript-history";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { anchorKey, type FixDraft } from "@/lib/fix-drafts";
import { apiRequest } from "@/lib/mutate";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

type Counts = {
  messages: number;
  toolCalls: number;
  errors: number;
  denied: number;
};

function countMessages(messages: UIMessage[]): Counts {
  const toolParts = messages
    .flatMap((message) => message.parts)
    .filter(isToolUIPart);
  return {
    messages: messages.length,
    toolCalls: toolParts.length,
    errors: toolParts.filter((part) => part.state === "output-error").length,
    denied: toolParts.filter((part) => part.state === "output-denied").length,
  };
}

function StatRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "danger" | "warning";
}) {
  return (
    <div className="flex items-center justify-between border-b px-4 py-2 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          "font-mono tabular-nums",
          value > 0 && tone === "danger" && "text-destructive",
          value > 0 && tone === "warning" && "text-warning",
        )}
      >
        {value}
      </span>
    </div>
  );
}

export function RunWorkspace({
  draftsEndpoint,
  messages,
  initialFixDrafts,
}: {
  draftsEndpoint: string;
  messages: UIMessage[];
  initialFixDrafts: FixDraft[];
}) {
  const [fixDrafts, setFixDrafts] = useState(initialFixDrafts);
  const [annotateTarget, setAnnotateTarget] = useState<AnnotateTarget | null>(
    null,
  );
  const [editingDraft, setEditingDraft] = useState<FixDraft | null>(null);
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const { copied, copy } = useCopyToClipboard();
  const refs = useRef(new Map<string, HTMLElement>());
  const highlightTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  function registerRef(key: string, el: HTMLElement | null) {
    if (el) refs.current.set(key, el);
    else refs.current.delete(key);
  }

  function jumpTo(key: string) {
    requestAnimationFrame(() => {
      refs.current
        .get(key)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightedKey(key);
      if (highlightTimeout.current) clearTimeout(highlightTimeout.current);
      highlightTimeout.current = setTimeout(
        () => setHighlightedKey(null),
        2000,
      );
    });
  }

  async function handleStatusChange(
    draftId: string,
    status: FixDraft["status"],
  ) {
    const previous = fixDrafts;
    setFixDrafts((current) =>
      current.map((draft) =>
        draft.id === draftId ? { ...draft, status } : draft,
      ),
    );
    try {
      await apiRequest(`${draftsEndpoint}/${draftId}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
    } catch (err) {
      setFixDrafts(previous);
      toast.error(err instanceof Error ? err.message : "Could not update.");
    }
  }

  const counts = countMessages(messages);
  const openCount = fixDrafts.filter((draft) => draft.status === "open").length;

  const draftsByAnchor = new Map<string, FixDraft[]>();
  for (const draft of fixDrafts) {
    const key = anchorKey(draft.messageId, draft.anchor);
    const existing = draftsByAnchor.get(key);
    if (existing) existing.push(draft);
    else draftsByAnchor.set(key, [draft]);
  }

  return (
    <div className="grid gap-6 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-4 lg:min-h-0">
        <div className="rounded-lg border bg-card p-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          <TranscriptHistory
            messages={messages}
            registerRef={registerRef}
            highlightedKey={highlightedKey}
            onAnnotate={setAnnotateTarget}
            draftsByAnchor={draftsByAnchor}
            onEditDraft={setEditingDraft}
          />
        </div>
        <Collapsible className="rounded-lg border bg-card lg:shrink-0">
          <div className="flex w-full items-center justify-between px-4 py-2.5">
            <CollapsibleTrigger className="flex flex-1 items-center gap-2 font-mono text-[11px] tracking-wider text-muted-foreground uppercase transition-colors hover:text-foreground">
              Raw JSON
              <ChevronDownIcon className="size-4 transition-transform group-data-open:rotate-180" />
            </CollapsibleTrigger>
            <button
              type="button"
              onClick={() => copy(JSON.stringify(messages, null, 2))}
              aria-label="Copy raw JSON"
              className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {copied ? (
                <CheckIcon className="size-3.5 text-success" />
              ) : (
                <CopyIcon className="size-3.5" />
              )}
            </button>
          </div>
          <CollapsibleContent>
            <ScrollArea className="h-72 border-t">
              <pre className="p-3 text-xs">
                {JSON.stringify(messages, null, 2)}
              </pre>
            </ScrollArea>
          </CollapsibleContent>
        </Collapsible>
      </div>

      <aside className="flex flex-col gap-4 lg:min-h-0">
        <div className="overflow-hidden rounded-lg border bg-card lg:shrink-0">
          <div className="border-b px-4 py-2.5">
            <h3 className="text-sm font-medium">Summary</h3>
          </div>
          <StatRow label="Messages" value={counts.messages} />
          <StatRow label="Tool calls" value={counts.toolCalls} />
          <StatRow label="Errors" value={counts.errors} tone="danger" />
          <StatRow label="Denied" value={counts.denied} tone="warning" />
        </div>

        <div className="flex flex-col overflow-hidden rounded-lg border bg-card lg:min-h-0 lg:flex-1">
          <div className="flex items-center justify-between border-b px-4 py-2.5 lg:shrink-0">
            <h3 className="text-sm font-medium">Fix Drafts</h3>
            {openCount > 0 && (
              <span className="rounded-full bg-primary/15 px-2 py-0.5 font-mono text-[11px] text-primary">
                {openCount} open
              </span>
            )}
          </div>
          <div className="p-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
            <FixDraftsPanel
              drafts={fixDrafts}
              messages={messages}
              onStatusChange={handleStatusChange}
              onEdit={setEditingDraft}
              onJumpTo={jumpTo}
            />
          </div>
        </div>
      </aside>

      <FixDraftDialog
        endpoint={draftsEndpoint}
        target={annotateTarget}
        editing={editingDraft}
        onOpenChange={(open) => {
          if (!open) {
            setAnnotateTarget(null);
            setEditingDraft(null);
          }
        }}
        onCreated={(draft) => setFixDrafts((current) => [...current, draft])}
        onUpdated={(draft) =>
          setFixDrafts((current) =>
            current.map((existing) =>
              existing.id === draft.id ? draft : existing,
            ),
          )
        }
      />
    </div>
  );
}
