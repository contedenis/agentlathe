"use client";

import type {
  ReviewedVerdict,
  RunEvaluationSkipReason,
  RunEvaluationStatus,
} from "@agentlathe/db/constants";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AnnotateButton } from "@/components/transcript-history";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/mutate";
import type { RunEvaluationView } from "@/lib/queries";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<RunEvaluationStatus, string> = {
  pass: "Pass",
  fail: "Fail",
  needs_review: "Needs review",
  not_applicable: "Not applicable",
  skipped: "Skipped",
  error: "Error",
};

const STATUS_CLASS: Record<RunEvaluationStatus, string> = {
  pass: "bg-success/15 text-success",
  fail: "bg-destructive/15 text-destructive",
  needs_review: "bg-warning/15 text-warning",
  not_applicable: "bg-muted text-muted-foreground",
  skipped: "bg-muted text-muted-foreground",
  error: "bg-warning/15 text-warning",
};

const SKIP_REASON_TEXT: Record<RunEvaluationSkipReason, string> = {
  too_long: "Transcript too long for the judge",
  awaiting_approval: "Run paused on an approval",
};

function reviewRank(evaluation: RunEvaluationView): number {
  const { status, reviewedVerdict } = evaluation;
  if (status === "error" || status === "skipped") return 2;
  if (reviewedVerdict) return 3;
  if (status === "fail") return 0;
  if (status === "needs_review") return 1;
  return status === "pass" ? 4 : 5;
}

function sortForReview(evaluations: RunEvaluationView[]): RunEvaluationView[] {
  return evaluations
    .map((evaluation, index) => ({ evaluation, index }))
    .sort(
      (a, b) =>
        reviewRank(a.evaluation) - reviewRank(b.evaluation) ||
        a.index - b.index,
    )
    .map(({ evaluation }) => evaluation);
}

type EvaluateResponse =
  | { skipped: "no_transcript" }
  | {
      evaluations: { status: RunEvaluationStatus }[];
      notJudged?: {
        status: RunEvaluationStatus;
        skipReason: RunEvaluationSkipReason | null;
        error: string | null;
      };
    };

function reportOutcome(result: EvaluateResponse) {
  if ("skipped" in result) {
    toast.error("No transcript is stored for this run.");
    return;
  }
  if (result.evaluations.length === 0) {
    toast.info("This agent has no active criteria to evaluate.");
    return;
  }
  const { notJudged } = result;
  if (notJudged?.status === "error") {
    toast.error(`The judge failed: ${notJudged.error ?? "unknown error"}`);
    return;
  }
  if (notJudged) {
    toast.warning(
      `Not judged: ${(notJudged.skipReason ? SKIP_REASON_TEXT[notJudged.skipReason] : "skipped").toLowerCase()}.`,
    );
    return;
  }
  const counts = { pass: 0, fail: 0, needs_review: 0, not_applicable: 0 };
  for (const { status } of result.evaluations)
    if (status in counts) counts[status as keyof typeof counts] += 1;
  const parts = [
    `${counts.pass} pass`,
    `${counts.fail} fail`,
    `${counts.needs_review} to review`,
  ];
  if (counts.not_applicable > 0)
    parts.push(`${counts.not_applicable} not applicable`);
  const total = result.evaluations.length;
  toast.success(
    `Evaluated ${total} ${total === 1 ? "criterion" : "criteria"}: ${parts.join(" · ")}`,
  );
}

function EvaluationRow({
  evaluation,
  pending,
  canNoteFix,
  onReview,
  onNoteFix,
}: {
  evaluation: RunEvaluationView;
  pending: boolean;
  canNoteFix: boolean;
  onReview: (verdict: ReviewedVerdict | null) => void;
  onNoteFix: () => void;
}) {
  const { status, reviewedVerdict } = evaluation;
  const reviewable =
    status === "pass" || status === "fail" || status === "needs_review";
  const effective: RunEvaluationStatus = reviewedVerdict ?? status;
  const overruled = reviewedVerdict !== null && reviewedVerdict !== status;

  return (
    <li className="flex flex-col gap-1.5 border-b px-4 py-3 last:border-b-0">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[11px] font-medium whitespace-nowrap",
            STATUS_CLASS[effective],
          )}
        >
          {STATUS_LABEL[effective]}
        </span>
        {evaluation.pPass !== null && (
          <span
            className="font-mono text-[11px] text-muted-foreground"
            title="Probability of a pass, as the judge scored it"
          >
            p {evaluation.pPass.toFixed(2)}
          </span>
        )}
      </div>

      <p className="text-sm break-words">{evaluation.questionSnapshot}</p>

      {evaluation.questionSnapshot !== evaluation.currentQuestion && (
        <p className="text-xs text-muted-foreground">
          Judged under an earlier wording
        </p>
      )}
      {!evaluation.criterionActive && (
        <p className="text-xs text-muted-foreground">Criterion is inactive</p>
      )}
      {status === "skipped" && (
        <p className="text-xs break-words text-muted-foreground">
          {evaluation.skipReason
            ? SKIP_REASON_TEXT[evaluation.skipReason]
            : "Not judged"}
        </p>
      )}
      {status === "error" && (
        <p
          className="line-clamp-3 text-xs break-words text-warning"
          title={evaluation.error ?? undefined}
        >
          {evaluation.error ?? "The judge failed."}
        </p>
      )}

      {reviewable && (
        <div className="flex flex-wrap items-center gap-1.5">
          {reviewedVerdict ? (
            <>
              <span className="text-xs">
                Reviewed
                {overruled && (
                  <span className="text-muted-foreground">
                    {" "}
                    · judge said {STATUS_LABEL[status]}
                  </span>
                )}
              </span>
              <Button
                variant="ghost"
                size="xs"
                disabled={pending}
                onClick={() => onReview(null)}
              >
                Undo
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="xs"
                disabled={pending}
                onClick={() => onReview("pass")}
              >
                Pass
              </Button>
              <Button
                variant="outline"
                size="xs"
                disabled={pending}
                onClick={() => onReview("fail")}
              >
                Fail
              </Button>
            </>
          )}
          {canNoteFix &&
            (effective === "fail" || effective === "needs_review") && (
              <AnnotateButton label="last assistant turn" onClick={onNoteFix} />
            )}
        </div>
      )}
    </li>
  );
}

export function EvaluationPanel({
  runId,
  agentId,
  source,
  evaluations,
  hasActiveCriteria,
  hasTranscript,
  canNoteFix,
  onNoteFix,
}: {
  runId: string;
  agentId: string;
  source: string;
  evaluations: RunEvaluationView[];
  hasActiveCriteria: boolean;
  hasTranscript: boolean;
  canNoteFix: boolean;
  onNoteFix: (evaluation: RunEvaluationView) => void;
}) {
  const router = useRouter();
  const [evaluating, setEvaluating] = useState(false);
  const [reviewingIds, setReviewingIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [refreshing, startRefresh] = useTransition();

  async function handleReevaluate() {
    setEvaluating(true);
    try {
      reportOutcome(
        await apiRequest<EvaluateResponse>(`/api/runs/${runId}/evaluate`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
      );
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not evaluate the run.",
      );
    } finally {
      setEvaluating(false);
    }
  }

  async function handleReview(
    evaluation: RunEvaluationView,
    verdict: ReviewedVerdict | null,
  ) {
    setReviewingIds((current) => new Set(current).add(evaluation.id));
    try {
      await apiRequest(`/api/runs/${runId}/evaluations/${evaluation.id}`, {
        method: "PATCH",
        body: JSON.stringify({ reviewedVerdict: verdict }),
      });
      startRefresh(() => router.refresh());
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not save the review.",
      );
    } finally {
      setReviewingIds((current) => {
        const next = new Set(current);
        next.delete(evaluation.id);
        return next;
      });
    }
  }

  const canEvaluate = hasActiveCriteria && hasTranscript;
  const sorted = sortForReview(evaluations);

  return (
    <div className="flex flex-col">
      {canEvaluate && (
        <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
          <span className="text-xs text-muted-foreground">
            {sorted.length > 0 &&
              `${sorted.length} ${sorted.length === 1 ? "verdict" : "verdicts"}`}
          </span>
          <Button
            variant="outline"
            size="xs"
            disabled={evaluating}
            onClick={handleReevaluate}
          >
            {evaluating ? "Evaluating..." : "Re-evaluate"}
          </Button>
        </div>
      )}

      {sorted.length > 0 ? (
        <ul>
          {sorted.map((evaluation) => (
            <EvaluationRow
              key={evaluation.id}
              evaluation={evaluation}
              pending={refreshing || reviewingIds.has(evaluation.id)}
              canNoteFix={canNoteFix}
              onReview={(verdict) => handleReview(evaluation, verdict)}
              onNoteFix={() => onNoteFix(evaluation)}
            />
          ))}
        </ul>
      ) : (
        <p className="px-4 py-4 text-sm break-words text-muted-foreground">
          {!hasActiveCriteria ? (
            <>
              No criteria for this agent yet.{" "}
              <Link
                href={`/agents/${agentId}`}
                className="text-primary hover:underline"
              >
                Add one on the agent page
              </Link>
              .
            </>
          ) : !hasTranscript ? (
            <>
              No transcript stored for this run, so it can&apos;t be evaluated.
              {source !== "dashboard" && (
                <>
                  {" "}
                  <Link
                    href={`/agents/${agentId}/edit`}
                    className="text-primary hover:underline"
                  >
                    Turn on external traffic recording
                  </Link>{" "}
                  to keep transcripts of API and MCP runs.
                </>
              )}
            </>
          ) : (
            "Not evaluated yet."
          )}
        </p>
      )}
    </div>
  );
}
