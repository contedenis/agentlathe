"use client";

import { PlusIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { CopyCriteriaDialog } from "@/components/copy-criteria-dialog";
import { CriterionDialog } from "@/components/criterion-dialog";
import { DeleteResourceButton } from "@/components/delete-resource-button";
import { EmptyState } from "@/components/empty-state";
import { ToggleActiveButton } from "@/components/toggle-active-button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { RecentEvaluationSummary } from "@/lib/evaluations";
import { apiRequest } from "@/lib/mutate";
import type {
  AgentCriteriaData,
  AgentCriterion,
  CriteriaCopySource,
} from "@/lib/queries";
import { cn } from "@/lib/utils";

function summaryMessage(summary: RecentEvaluationSummary): string {
  const parts = [
    `${summary.pass} pass`,
    `${summary.fail} fail`,
    `${summary.needsReview} to review`,
  ];
  if (summary.notApplicable > 0)
    parts.push(`${summary.notApplicable} not applicable`);
  if (summary.error > 0)
    parts.push(`${summary.error} ${summary.error === 1 ? "error" : "errors"}`);
  if (summary.notJudged > 0) parts.push(`${summary.notJudged} not judged`);
  if (summary.stoppedEarly)
    parts.push(
      summary.stoppedEarly === "judge_failing"
        ? "stopped early: the judge kept failing"
        : "stopped early",
    );
  return `Re-evaluated ${summary.runs} ${summary.runs === 1 ? "run" : "runs"}: ${parts.join(" · ")}`;
}

function CriterionRow({
  agentId,
  criterion,
  onEdit,
}: {
  agentId: string;
  criterion: AgentCriterion;
  onEdit: (criterion: AgentCriterion) => void;
}) {
  const { stats } = criterion;
  const endpoint = `/api/agents/${agentId}/criteria/${criterion.id}`;
  const judged = stats.pass + stats.fail > 0;
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border bg-card p-3",
        !criterion.isActive && "bg-muted/30",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div
          className={cn(
            "flex min-w-0 flex-col gap-1",
            !criterion.isActive && "text-muted-foreground",
          )}
        >
          <p className="text-sm font-medium break-words">
            {criterion.question}
          </p>
          {!criterion.isActive && (
            <Badge variant="outline" className="self-start">
              Inactive
            </Badge>
          )}
        </div>
        <div className="shrink-0 text-right">
          <p
            className={cn(
              "font-mono text-lg leading-none tabular-nums",
              !criterion.isActive && "text-muted-foreground",
            )}
            title="Pass rate over the last 30 days"
          >
            {stats.passRate === null
              ? "—"
              : `${Math.round(stats.passRate * 100)}%`}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">pass rate</p>
        </div>
      </div>

      {(criterion.passDescription ||
        criterion.failDescription ||
        criterion.appliesWhen) && (
        <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {criterion.passDescription && (
            <p className="break-words">
              <span className="font-medium text-foreground">Passes when:</span>{" "}
              {criterion.passDescription}
            </p>
          )}
          {criterion.failDescription && (
            <p className="break-words">
              <span className="font-medium text-foreground">Fails when:</span>{" "}
              {criterion.failDescription}
            </p>
          )}
          {criterion.appliesWhen && (
            <p className="break-words">
              <span className="font-medium text-foreground">Only when:</span>{" "}
              {criterion.appliesWhen}
            </p>
          )}
        </div>
      )}

      <p className="font-mono text-[11px] text-muted-foreground">
        {judged || stats.needsReview > 0 ? (
          <>
            {stats.pass} pass · {stats.fail} fail
          </>
        ) : (
          "No verdicts in the last 30 days"
        )}
        {stats.needsReview > 0 && (
          <>
            {" · "}
            <span className="rounded-full bg-warning/15 px-1.5 py-0.5 font-medium text-warning">
              {stats.needsReview} need review
            </span>
          </>
        )}
      </p>

      <div className="-ml-2.5 flex flex-wrap gap-1">
        <Button variant="ghost" size="sm" onClick={() => onEdit(criterion)}>
          Edit
        </Button>
        <ToggleActiveButton
          endpoint={endpoint}
          isActive={criterion.isActive}
          size="sm"
          variant="ghost"
        />
        <DeleteResourceButton
          endpoint={endpoint}
          resourceLabel="the criterion"
          redirectTo={`/agents/${agentId}`}
          size="sm"
          subtle
          description="This also deletes every verdict recorded for this criterion. It cannot be undone. If you only want to stop evaluating it, use Deactivate instead."
        />
      </div>
    </div>
  );
}

export function CriteriaPanel({
  agentId,
  autoEvaluate,
  recordTraffic,
  criteria,
  lastEvaluationError,
  copySources,
}: {
  agentId: string;
  autoEvaluate: boolean;
  recordTraffic: boolean;
  criteria: AgentCriterion[];
  lastEvaluationError: AgentCriteriaData["lastEvaluationError"];
  copySources: CriteriaCopySource[];
}) {
  const router = useRouter();
  const [evaluating, setEvaluating] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AgentCriterion | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }

  async function handleReevaluate() {
    setEvaluating(true);
    try {
      const summary = await apiRequest<RecentEvaluationSummary>(
        `/api/agents/${agentId}/criteria/evaluate-recent`,
        { method: "POST" },
      );
      if (summary.runs === 0)
        toast.info("No runs with a stored transcript to evaluate.");
      else if (summary.stoppedEarly || summary.error > 0)
        toast.warning(summaryMessage(summary));
      else toast.success(summaryMessage(summary));
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not evaluate.");
    } finally {
      setEvaluating(false);
    }
  }

  const hasActive = criteria.some((criterion) => criterion.isActive);
  const empty = criteria.length === 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 rounded-lg border bg-card px-3 py-2.5 text-sm">
        <span className={autoEvaluate ? undefined : "text-muted-foreground"}>
          {autoEvaluate
            ? "New runs are evaluated automatically."
            : "Automatic evaluation is off: runs are judged only when you re-evaluate them."}
        </span>
        <Link
          href={`/agents/${agentId}/edit`}
          className="shrink-0 text-primary hover:underline"
        >
          Change
        </Link>
      </div>

      <div className="flex flex-wrap gap-2">
        {!empty && (
          <Button size="sm" onClick={openCreate}>
            <PlusIcon />
            Add criterion
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={copySources.length === 0}
          title={
            copySources.length === 0
              ? "No other agent has criteria yet."
              : undefined
          }
          onClick={() => setCopyOpen(true)}
        >
          Copy from agent…
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={evaluating || !hasActive}
          onClick={handleReevaluate}
        >
          {evaluating ? "Evaluating..." : "Re-evaluate recent runs"}
        </Button>
      </div>

      {!empty && !recordTraffic && (
        <Alert>
          <TriangleAlertIcon />
          <AlertDescription>
            Runs from /v1 and MCP aren&apos;t evaluated: this agent doesn&apos;t
            record their transcripts.{" "}
            <Link href={`/agents/${agentId}/edit`}>Edit the agent</Link> to
            record them.
          </AlertDescription>
        </Alert>
      )}

      {lastEvaluationError && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertDescription>
            <p>{`The last evaluation failed: ${lastEvaluationError.message}`}</p>
            <p className="text-xs">
              {lastEvaluationError.at.toLocaleString("en-US")}. A judge endpoint
              without the Decisions API, a bad key or a bad judge model all
              surface here.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {empty ? (
        <EmptyState
          title="No criteria yet"
          description="Yes/no questions a judge answers about every run — phrase them so 'yes' is good. You can also turn a fix draft into a criterion from a run."
          action={
            <Button size="sm" onClick={openCreate}>
              <PlusIcon />
              Add criterion
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {criteria.map((criterion) => (
            <CriterionRow
              key={criterion.id}
              agentId={agentId}
              criterion={criterion}
              onEdit={(row) => {
                setEditing(row);
                setFormOpen(true);
              }}
            />
          ))}
        </div>
      )}

      <CriterionDialog
        agentId={agentId}
        open={formOpen}
        onOpenChange={setFormOpen}
        criterion={editing}
      />
      <CopyCriteriaDialog
        agentId={agentId}
        open={copyOpen}
        onOpenChange={setCopyOpen}
        sources={copySources}
      />
    </div>
  );
}
