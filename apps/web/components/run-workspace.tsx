"use client";

import { CRITERION_DESCRIPTION_MAX_LENGTH } from "@agentlathe/db/constants";
import { isToolUIPart, type UIMessage } from "@agentlathe/runner/chat-ui";
import { CheckIcon, ChevronDownIcon, CopyIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { CriterionDialog } from "@/components/criterion-dialog";
import { EvaluationPanel } from "@/components/evaluation-panel";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { anchorKey, type FixDraft } from "@/lib/fix-drafts";
import { apiRequest } from "@/lib/mutate";
import type { RunEvaluationView } from "@/lib/queries";
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

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "danger" | "warning";
}) {
  return (
    <div className="flex flex-col gap-0.5 px-3 py-2">
      <dt className="font-mono text-[9.5px] tracking-wider whitespace-nowrap text-muted-foreground uppercase">
        {label}
      </dt>
      <dd
        className={cn(
          "font-mono text-sm tabular-nums",
          value > 0 && tone === "danger" && "text-destructive",
          value > 0 && tone === "warning" && "text-warning",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function CountBadge({
  count,
  label,
  className,
}: {
  count: number;
  label: string;
  className: string;
}) {
  if (count === 0) return null;
  return (
    <span
      title={label}
      className={cn(
        "rounded-full px-1.5 font-mono text-[10.5px] tabular-nums",
        className,
      )}
    >
      {count} <span className="sr-only">{label}</span>
    </span>
  );
}

function needsAttention(evaluation: RunEvaluationView): boolean {
  return (
    evaluation.criterionActive &&
    evaluation.questionSnapshot === evaluation.currentQuestion &&
    evaluation.reviewedVerdict === null &&
    (evaluation.status === "fail" || evaluation.status === "needs_review")
  );
}

type SidebarTab = "evaluation" | "fix-drafts";

function lastAssistantMessageId(messages: UIMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "assistant")
      return messages[index].id || `turn-${index}`;
  }
  return null;
}

export function RunWorkspace({
  agentId,
  runId,
  source,
  draftsEndpoint,
  messages,
  initialFixDrafts,
  evaluations,
  hasActiveCriteria,
  hasTranscript,
}: {
  agentId: string;
  runId: string;
  source: string;
  draftsEndpoint: string;
  messages: UIMessage[];
  initialFixDrafts: FixDraft[];
  evaluations: RunEvaluationView[];
  hasActiveCriteria: boolean;
  hasTranscript: boolean;
}) {
  const [fixDrafts, setFixDrafts] = useState(initialFixDrafts);
  const [annotateTarget, setAnnotateTarget] = useState<AnnotateTarget | null>(
    null,
  );
  const [editingDraft, setEditingDraft] = useState<FixDraft | null>(null);
  const [promotingDraft, setPromotingDraft] = useState<FixDraft | null>(null);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const [tab, setTab] = useState<SidebarTab>(() =>
    evaluations.some(needsAttention) ||
    !initialFixDrafts.some((draft) => draft.status === "open")
      ? "evaluation"
      : "fix-drafts",
  );
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

  const lastAssistantId = lastAssistantMessageId(messages);

  function noteFixFromVerdict(evaluation: RunEvaluationView) {
    if (!lastAssistantId) return;
    const failed = (evaluation.reviewedVerdict ?? evaluation.status) === "fail";
    const lead = failed ? "Failed criterion" : "Judge unsure on criterion";
    setAnnotateTarget({
      messageId: lastAssistantId,
      anchor: { type: "turn" },
      label: "Last assistant turn",
      rationale: `${lead}: ${evaluation.questionSnapshot}`,
    });
  }

  const counts = countMessages(messages);
  const openCount = fixDrafts.filter((draft) => draft.status === "open").length;
  const attention = evaluations.filter(needsAttention);
  const attentionClass = attention.some(
    (evaluation) => evaluation.status === "fail",
  )
    ? "bg-destructive/15 text-destructive"
    : "bg-warning/15 text-warning";

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
        <section
          aria-label="Summary"
          className="rounded-lg border bg-card lg:shrink-0"
        >
          <dl className="grid grid-cols-4 divide-x">
            <Stat label="Messages" value={counts.messages} />
            <Stat label="Tool calls" value={counts.toolCalls} />
            <Stat label="Errors" value={counts.errors} tone="danger" />
            <Stat label="Denied" value={counts.denied} tone="warning" />
          </dl>
        </section>

        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as SidebarTab)}
          className="flex flex-col overflow-hidden rounded-lg border bg-card lg:min-h-0 lg:flex-1"
        >
          <div className="border-b p-2 lg:shrink-0">
            <TabsList className="w-full">
              <TabsTrigger value="evaluation">
                Evaluation{" "}
                <CountBadge
                  count={attention.length}
                  label="to review"
                  className={attentionClass}
                />
              </TabsTrigger>
              <TabsTrigger value="fix-drafts">
                Fix drafts{" "}
                <CountBadge
                  count={openCount}
                  label="open"
                  className="bg-primary/15 text-primary"
                />
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent
            value="evaluation"
            keepMounted
            className="lg:min-h-0 lg:overflow-y-auto"
          >
            <EvaluationPanel
              runId={runId}
              agentId={agentId}
              source={source}
              evaluations={evaluations}
              hasActiveCriteria={hasActiveCriteria}
              hasTranscript={hasTranscript}
              canNoteFix={lastAssistantId !== null}
              onNoteFix={noteFixFromVerdict}
            />
          </TabsContent>
          <TabsContent
            value="fix-drafts"
            keepMounted
            className="p-3 lg:min-h-0 lg:overflow-y-auto"
          >
            <FixDraftsPanel
              drafts={fixDrafts}
              messages={messages}
              onStatusChange={handleStatusChange}
              onEdit={setEditingDraft}
              onPromote={(draft) => {
                setPromotingDraft(draft);
                setPromoteOpen(true);
              }}
              onJumpTo={jumpTo}
            />
          </TabsContent>
        </Tabs>
      </aside>

      <CriterionDialog
        agentId={agentId}
        open={promoteOpen}
        onOpenChange={setPromoteOpen}
        prefill={
          promotingDraft
            ? {
                failDescription: promotingDraft.rationale.slice(
                  0,
                  CRITERION_DESCRIPTION_MAX_LENGTH,
                ),
                sourceFixDraftId: promotingDraft.id,
              }
            : null
        }
        previewRunId={runId}
      />

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
        onCreated={(draft) => {
          setFixDrafts((current) => [...current, draft]);
          setTab("fix-drafts");
        }}
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
