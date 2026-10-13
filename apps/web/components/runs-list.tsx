"use client";

import { CheckIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { LIST_TABLE_CLASS, SearchInput } from "@/components/list-search";
import { RunStatusBadge } from "@/components/run-status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { listRunsPage } from "@/lib/queries";
import {
  EVALUATION_FILTER_LABEL,
  EVALUATION_FILTERS,
  type EvaluationFilter,
} from "@/lib/run-evaluation-filter";
import { SOURCE_LABEL, SOURCE_ORDER, sourceLabel } from "@/lib/run-sources";
import { cn } from "@/lib/utils";

type RunRow = Awaited<ReturnType<typeof listRunsPage>>["rows"][number];

const SOURCES = [
  { value: "", label: "All sources" },
  ...SOURCE_ORDER.map((source) => ({
    value: source,
    label: SOURCE_LABEL[source],
  })),
];

const PILL =
  "rounded-full px-2 py-0.5 font-mono text-[11px] font-medium whitespace-nowrap";

function EvaluationSummary({ run }: { run: RunRow }) {
  if (run.evaluationTotal === 0) return null;
  const needsAttention = run.evaluationFailed + run.evaluationNeedsReview > 0;
  const unjudged = run.evaluationErrors + run.evaluationSkipped > 0;
  const clear = run.evaluationClear === run.evaluationTotal;

  if (!needsAttention && !unjudged && clear) {
    return run.evaluationPassed > 0 ? (
      <CheckIcon className="size-4 text-success" aria-label="No failures" />
    ) : (
      <span className={cn(PILL, "bg-muted text-muted-foreground")}>n/a</span>
    );
  }

  return (
    <div className="flex flex-wrap gap-1">
      {run.evaluationFailed > 0 && (
        <span className={cn(PILL, "bg-destructive/15 text-destructive")}>
          {run.evaluationFailed} fail
        </span>
      )}
      {run.evaluationNeedsReview > 0 && (
        <span className={cn(PILL, "bg-warning/15 text-warning")}>
          {run.evaluationNeedsReview} to review
        </span>
      )}
      {!needsAttention && run.evaluationErrors > 0 && (
        <span className={cn(PILL, "bg-warning/15 text-warning")}>error</span>
      )}
      {!needsAttention && run.evaluationSkipped > 0 && (
        <span className={cn(PILL, "bg-muted text-muted-foreground")}>
          skipped
        </span>
      )}
    </div>
  );
}

function FilterGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="flex min-w-0 flex-wrap items-center gap-1.5">
      <legend className="sr-only">{label}</legend>
      <span
        aria-hidden
        className="font-mono text-[10.5px] tracking-wider text-faint uppercase"
      >
        {label}
      </span>
      {children}
    </fieldset>
  );
}

const EVALUATION_OPTIONS: { value: EvaluationFilter | ""; label: string }[] = [
  { value: "", label: "All" },
  ...EVALUATION_FILTERS.map((filter) => ({
    value: filter,
    label: EVALUATION_FILTER_LABEL[filter],
  })),
];

export function RunsList({
  runs,
  total,
  query,
  source,
  evaluation,
  needsReviewTotal,
  page,
  pageSize,
}: {
  runs: RunRow[];
  total: number;
  query: string;
  source: string;
  evaluation: EvaluationFilter | "";
  needsReviewTotal: number;
  page: number;
  pageSize: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [value, setValue] = useState(query);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function hrefFor(
    nextQuery: string,
    nextSource: string,
    nextEvaluation: EvaluationFilter | "",
    nextPage: number,
  ) {
    const params = new URLSearchParams();
    if (nextQuery.trim()) params.set("q", nextQuery.trim());
    if (nextSource) params.set("source", nextSource);
    if (nextEvaluation) params.set("evaluation", nextEvaluation);
    if (nextPage > 1) params.set("page", String(nextPage));
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  function onSearch(next: string) {
    setValue(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(
      () => router.replace(hrefFor(next, source, evaluation, 1)),
      300,
    );
  }

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 lg:shrink-0">
        <SearchInput
          value={value}
          onChange={onSearch}
          placeholder="Search by agent…"
        />
        <FilterGroup label="Source">
          {SOURCES.map((option) => (
            <Button
              key={option.value || "all"}
              variant={source === option.value ? "secondary" : "ghost"}
              size="sm"
              nativeButton={false}
              render={
                <Link href={hrefFor(query, option.value, evaluation, 1)} />
              }
            >
              {option.label}
            </Button>
          ))}
        </FilterGroup>
        <FilterGroup label="Evaluation">
          {EVALUATION_OPTIONS.map((option) => (
            <Button
              key={option.value || "all"}
              variant={evaluation === option.value ? "secondary" : "ghost"}
              size="sm"
              nativeButton={false}
              render={<Link href={hrefFor(query, source, option.value, 1)} />}
            >
              {option.label}
              {option.value === "needs_review" && needsReviewTotal > 0 && (
                <span className="font-mono text-[11px] text-warning">
                  {needsReviewTotal}
                </span>
              )}
            </Button>
          ))}
        </FilterGroup>
        <span className="font-mono text-[11px] text-faint">
          {total} {total === 1 ? "result" : "results"}
        </span>
      </div>

      <Table containerClassName={LIST_TABLE_CLASS}>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Evaluation</TableHead>
            <TableHead>Duration</TableHead>
            <TableHead>Notes</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={7}
                className="py-10 text-center text-muted-foreground"
              >
                {evaluation === "needs_review"
                  ? "Nothing to review."
                  : "No runs match this filter."}
              </TableCell>
            </TableRow>
          ) : (
            runs.map((run) => (
              <TableRow key={run.id}>
                <TableCell>
                  <Link
                    href={`/runs/${run.id}`}
                    className="font-mono text-[12px] font-medium hover:underline"
                  >
                    {run.createdAt?.toLocaleString("en-US") ?? "—"}
                  </Link>
                </TableCell>
                <TableCell>
                  <Link
                    href={`/agents/${run.agentId}`}
                    className="text-muted-foreground hover:underline"
                  >
                    {run.agentName}
                  </Link>
                </TableCell>
                <TableCell>
                  <span className="font-mono text-[11px] text-faint uppercase">
                    {sourceLabel(run.source)}
                  </span>
                </TableCell>
                <TableCell>
                  <RunStatusBadge status={run.status} />
                </TableCell>
                <TableCell>
                  <EvaluationSummary run={run} />
                </TableCell>
                <TableCell className="font-mono text-[12px] text-faint tabular-nums">
                  {(run.durationMs / 1000).toFixed(1)}s
                </TableCell>
                <TableCell>
                  {run.openDrafts > 0 ? (
                    <Badge variant="default">{run.openDrafts} open</Badge>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <div className="flex items-center justify-between gap-3 lg:shrink-0">
        <span className="font-mono text-[11px] text-faint">
          Page {page} of {totalPages}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            // Disabled it stays a real button; enabled it renders an anchor.
            nativeButton={page <= 1}
            render={
              page > 1 ? (
                <Link href={hrefFor(query, source, evaluation, page - 1)} />
              ) : undefined
            }
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            nativeButton={page >= totalPages}
            render={
              page < totalPages ? (
                <Link href={hrefFor(query, source, evaluation, page + 1)} />
              ) : undefined
            }
          >
            Next
          </Button>
        </div>
      </div>
    </>
  );
}
