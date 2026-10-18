import { ChartNoAxesColumnIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { Hint, MetricHint } from "@/components/metric-hint";
import {
  LatencyChart,
  RunsChart,
  RunsSparkline,
  TokensChart,
} from "@/components/metrics-charts";
import { KIND_LABEL, Stat, Trend } from "@/components/metrics-primitives";
import { MetricsRangePicker } from "@/components/metrics-range-picker";
import { PageHeader } from "@/components/page-header";
import { PaginatedTable } from "@/components/paginated-table";
import { TrackingSettings } from "@/components/tracking-settings";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { compact, fmt, formatCost, formatDuration } from "@/lib/format";
import { judgeHost } from "@/lib/judge";
import {
  buildChartPoints,
  type EvaluationSummary,
} from "@/lib/metrics-assembly";
import {
  type MetricsRangeParams,
  parseMetricsRange,
  periodLabel,
  previousRangeStart,
  rangeHref,
} from "@/lib/metrics-range";
import { estimateCostUsd, getOpenRouterModels } from "@/lib/openrouter-models";
import { getMetricsData } from "@/lib/queries-metrics";
import { scheduleRetentionSweep } from "@/lib/retention";
import { sourceLabel } from "@/lib/run-sources";

function PassRateCell({ stats }: { stats: EvaluationSummary | undefined }) {
  if (!stats || stats.passRate === null)
    return <span className="text-muted-foreground">—</span>;
  return (
    <>
      {Math.round(stats.passRate * 100)}%
      <div className="text-[11px] text-muted-foreground">
        n={stats.pass + stats.fail}
      </div>
    </>
  );
}

export default async function MetricsPage({
  searchParams,
}: {
  searchParams: Promise<MetricsRangeParams>;
}) {
  const range = parseMetricsRange(await searchParams);
  const rangeDays = range.days.length;
  const [
    {
      settings,
      totals,
      byAgent,
      neverRun,
      byTool,
      daily,
      dailyLatency,
      days,
      firstRunAt,
      lastRunAt,
      evaluation,
    },
    models,
  ] = await Promise.all([getMetricsData(range), getOpenRouterModels()]);

  scheduleRetentionSweep(settings);

  const anyEnabled =
    settings.trackDashboardRuns ||
    settings.trackV1Runs ||
    settings.trackMcpRuns ||
    settings.trackScheduleRuns;

  const { runPoints, latencyPoints, tokenPoints, sources } = buildChartPoints(
    daily,
    dailyLatency,
    days,
  );

  const totalCost = byAgent.reduce<number | null>((sum, row) => {
    const cost = estimateCostUsd(
      models,
      row.model,
      row.inputTokens,
      row.outputTokens,
    );
    if (cost === null) return sum;
    return (sum ?? 0) + cost;
  }, null);

  const unusedTotal = byAgent.reduce(
    (total, row) => total + row.unused.length,
    0,
  );
  const denied = byTool
    .filter((row) => row.denied > 0)
    .sort((a, b) => b.denied - a.denied);

  const hasPreviousData =
    firstRunAt !== null &&
    firstRunAt.getTime() <= previousRangeStart(range).getTime();

  const period = periodLabel(range);
  const judgedTotal = evaluation.overall.pass + evaluation.overall.fail;
  const hasEvaluation =
    judgedTotal +
      evaluation.overall.needsReview +
      evaluation.awaitingReviewRuns >
    0;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader
          eyebrow="Observability"
          title="Metrics"
          description="One row per run, with no message content. Only what you enable gets recorded."
        />
        <div className="flex flex-wrap items-center gap-2">
          <TrackingSettings settings={settings} judgeHost={judgeHost()} />
          <MetricsRangePicker basePath="/metrics" range={range} />
        </div>
      </div>

      {!anyEnabled && (
        <Alert>
          <TriangleAlertIcon className="text-warning" />
          <AlertTitle>No source is being recorded</AlertTitle>
          <AlertDescription>
            Enable at least one in the picker above. Until then this page stays
            empty no matter how much you use the agents.
          </AlertDescription>
        </Alert>
      )}

      {totals.runs === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <ChartNoAxesColumnIcon className="size-8 text-faint" />
            <p className="font-medium">No runs recorded in {period}</p>
            <p className="max-w-md text-sm text-muted-foreground">
              {anyEnabled
                ? "Tracking is on. Try another range or wait for the next agent run."
                : "Enable at least one source to start recording."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label="Runs"
              value={fmt(totals.runs)}
              sub={`${Math.round((totals.errors / totals.runs) * 100)}% failed`}
            />
            <Stat
              label="Latency"
              value={formatDuration(totals.p95DurationMs)}
              sub={`typical run ${formatDuration(totals.p50DurationMs)}`}
              hint="The large number is the p95: 95% of runs finished in less than that. It is the reasonable worst case, not the average. The median sits below it."
            />
            <Stat
              label="Tokens"
              value={compact(totals.tokens)}
              sub={`${compact(totals.inputTokens)} in · ${compact(totals.outputTokens)} out`}
              hint="Input includes the system prompt, the skills and the definition of every plugged-in tool, repeated on every step of the agent."
            />
            <Stat
              label="Cost"
              value={formatCost(totalCost)}
              sub={
                totalCost === null
                  ? "no published price"
                  : "estimated with provider-published prices"
              }
            />
          </div>

          {hasEvaluation && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Stat
                label="Evaluation pass rate"
                value={
                  evaluation.overall.passRate === null
                    ? "—"
                    : `${Math.round(evaluation.overall.passRate * 100)}%`
                }
                sub={`${fmt(judgedTotal)} judged verdicts across agents`}
                hint="Pass over pass plus fail across every agent's active criteria. Your reviews count over the judge's verdicts. Unsure verdicts nobody resolved yet are left out, and so are verdicts for a question that has since been edited."
              />
              <Stat
                label="Runs awaiting review"
                value={fmt(evaluation.awaitingReviewRuns)}
                sub={
                  evaluation.awaitingReviewRuns > 0 ? (
                    <Link
                      href="/runs?evaluation=needs_review"
                      className="text-foreground hover:text-primary"
                    >
                      Open the review queue
                    </Link>
                  ) : (
                    "nothing waiting for a human verdict"
                  )
                }
                hint="Runs with at least one verdict the judge could not decide and nobody has resolved yet, for an active criterion on its current question. It is not limited to the selected range: it counts the same runs as the review queue it links to."
              />
            </div>
          )}

          <div className="grid gap-5 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Runs per day</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Stacked by where the invocation came in. The red line is the
                  ones that ended in an error.
                </p>
              </CardHeader>
              <CardContent>
                <RunsChart data={runPoints} sources={sources} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Latency</CardTitle>
                <p className="text-sm text-muted-foreground">
                  How long a run takes end to end. The gap between p50 and p95
                  measures how unpredictable it is.
                </p>
              </CardHeader>
              <CardContent>
                <LatencyChart data={latencyPoints} />
              </CardContent>
            </Card>

            <Card className="xl:col-span-2">
              <CardHeader>
                <CardTitle>Tokens per day</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Input grows with the system prompt, the skills and the
                  definition of every plugged-in tool. It is what you pay on
                  every step.
                </p>
              </CardHeader>
              <CardContent>
                <TokensChart data={tokenPoints} />
              </CardContent>
            </Card>
          </div>

          {denied.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Rejected approvals</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                  What the agent tried to do and the user did not allow. A high
                  rejection rate is fixed in the system prompt or by removing
                  the tool.
                </p>
                {denied.map((row) => {
                  const attempts = row.calls + row.denied;
                  return (
                    <div
                      key={`${row.kind}:${row.name}`}
                      className="flex items-center justify-between gap-4 border-b pb-2 text-sm last:border-0 last:pb-0"
                    >
                      <span className="font-medium">{row.name}</span>
                      <span className="shrink-0 text-muted-foreground">
                        <span className="text-warning">
                          {fmt(row.denied)} rejected
                        </span>{" "}
                        of {fmt(attempts)} attempts ·{" "}
                        {Math.round((row.denied / attempts) * 100)}%
                      </span>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>By agent</CardTitle>
              <p className="text-sm text-muted-foreground">
                One row per agent with runs in {period}. Click the name for the
                detail.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <PaginatedTable
                head={
                  <>
                    <TableHead>Agent</TableHead>
                    <TableHead>
                      <MetricHint label={`Usage (${rangeDays} d)`}>
                        <span>
                          The chart is the shape of usage day by day. Each one
                          scales to its own maximum, so it reads the rhythm, not
                          the volume across agents — that is what the number
                          next to it is for.
                        </span>
                        <span>
                          The change compares against the {rangeDays} days
                          before the period.
                        </span>
                      </MetricHint>
                    </TableHead>
                    <TableHead>
                      <MetricHint label="Latency">
                        <span>
                          How long a whole run takes, not a single tool call.
                        </span>
                        <span>
                          The large number is the p95: 95% of runs finished in
                          less than that, the reasonable worst case. Below it is
                          the typical run (median). The further apart, the more
                          unpredictable.
                        </span>
                      </MetricHint>
                    </TableHead>
                    <TableHead>
                      <MetricHint label="Reliability">
                        <span>
                          Runs that ended in an error, over the total for the
                          period.
                        </span>
                      </MetricHint>
                    </TableHead>
                    <TableHead>
                      <MetricHint label="Pass rate">
                        <span>
                          Share of judged verdicts that passed the agent's
                          active criteria in the period, with your reviews
                          counted over the judge's. A dash means nothing was
                          judged.
                        </span>
                      </MetricHint>
                    </TableHead>
                    <TableHead>
                      <MetricHint label="Cost">
                        <span>
                          Estimated with the prices the provider's catalog
                          publishes for the agent's model. If the model
                          publishes no price, it shows a dash instead of
                          inventing a number.
                        </span>
                      </MetricHint>
                    </TableHead>
                    <TableHead>
                      <MetricHint label="Capabilities">
                        <span>
                          Tools, skills, MCP and sub-agents it has plugged in,
                          and how many were never called during the period.
                        </span>
                        <span>
                          The unused ones still enter the prompt on every step.
                        </span>
                      </MetricHint>
                    </TableHead>
                  </>
                }
              >
                {byAgent.map((row) => (
                  <TableRow key={row.agentId}>
                    <TableCell>
                      <Link
                        href={rangeHref(`/metrics/${row.agentId}`, range)}
                        className="font-medium hover:text-primary"
                      >
                        {row.agentName}
                      </Link>
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {row.model}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <RunsSparkline
                          data={days.map((day, index) => ({
                            day,
                            runs: row.series[index] ?? 0,
                          }))}
                          label={`${row.agentName}: runs per day`}
                        />
                        <div>
                          <div>
                            <span className="font-medium">
                              {fmt(row.runs)} runs
                            </span>
                            <span className="text-muted-foreground">
                              {" "}
                              · {row.activeDays} of {days.length} days with use
                            </span>
                          </div>
                          <div className="text-[11px]">
                            <Trend
                              recent={row.recentRuns}
                              previous={row.previousRuns}
                              days={rangeDays}
                              comparable={hasPreviousData}
                            />
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {formatDuration(row.p95DurationMs)}
                      <div className="text-[11px] text-muted-foreground">
                        typical {formatDuration(row.p50DurationMs)}
                      </div>
                    </TableCell>
                    <TableCell>
                      {row.errors > 0 ? (
                        <>
                          <span className="text-destructive">
                            {Math.round((row.errors / row.runs) * 100)}% failed
                          </span>
                          <div className="text-[11px] text-muted-foreground">
                            {fmt(row.errors)} of {fmt(row.runs)}
                          </div>
                        </>
                      ) : (
                        <span className="text-muted-foreground">no errors</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <PassRateCell stats={evaluation.byAgent[row.agentId]} />
                    </TableCell>
                    <TableCell>
                      {formatCost(
                        estimateCostUsd(
                          models,
                          row.model,
                          row.inputTokens,
                          row.outputTokens,
                        ),
                      )}
                      <div className="text-[11px] text-muted-foreground">
                        {compact(row.inputTokens + row.outputTokens)} tokens
                      </div>
                    </TableCell>
                    <TableCell>
                      {row.unused.length > 0 ? (
                        <Hint
                          trigger={
                            <span className="text-warning">
                              {row.unused.length} unused
                            </span>
                          }
                        >
                          <span className="font-medium">
                            Plugged in and never called during the period:
                          </span>
                          <span>
                            {row.unused.map((item) => item.name).join(", ")}
                          </span>
                        </Hint>
                      ) : (
                        <span className="text-muted-foreground">
                          all in use
                        </span>
                      )}
                      <div className="text-[11px] text-muted-foreground">
                        {row.configured} configured
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </PaginatedTable>
              {neverRun.length > 0 && (
                <div className="border-t px-4 py-3 text-sm">
                  <span className="font-medium text-warning">
                    {neverRun.length}{" "}
                    {neverRun.length === 1
                      ? "active agent with no runs in the period"
                      : "active agents with no runs in the period"}
                    :
                  </span>{" "}
                  {neverRun.map((agent, index) => (
                    <span key={agent.id}>
                      {index > 0 && ", "}
                      <Link
                        href={`/agents/${agent.id}`}
                        className="hover:text-primary"
                      >
                        {agent.name}
                      </Link>
                    </span>
                  ))}
                  <p className="mt-1 text-muted-foreground text-xs">
                    They are deployed and nobody used them in {period}. Either
                    they are not needed, or nobody knows they exist.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {unusedTotal > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Configured and unused during the period</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                  Extra capabilities are not free: they enter the prompt on
                  every step and compete for the model's attention when it picks
                  one. Removing the unused ones usually improves selection and
                  lowers the bill.
                </p>
                {byAgent
                  .filter((row) => row.unused.length > 0)
                  .map((row) => (
                    <div key={row.agentId} className="text-sm">
                      <Link
                        href={`/agents/${row.agentId}/edit`}
                        className="font-medium hover:text-primary"
                      >
                        {row.agentName}
                      </Link>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {row.unused.map((item) => (
                          <span
                            key={`${item.kind}:${item.name}`}
                            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                          >
                            {item.displayName}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Reliability by capability</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <PaginatedTable
                head={
                  <>
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>
                      <MetricHint label="Calls">
                        <span>
                          Times an agent executed it. Attempts the user rejected
                          at the approval prompt are not counted.
                        </span>
                      </MetricHint>
                    </TableHead>
                    <TableHead>
                      <MetricHint label="Reliability">
                        <span>
                          Calls that returned an error, over total executions.
                        </span>
                      </MetricHint>
                    </TableHead>
                    <TableHead>
                      <MetricHint label="Latency">
                        <span>
                          p95 of how long the capability itself takes, not
                          counting the model thinking around it.
                        </span>
                        <span>
                          Calls made from the dashboard chat do not record a
                          duration, so they show a dash.
                        </span>
                      </MetricHint>
                    </TableHead>
                    <TableHead>Invoked from</TableHead>
                  </>
                }
              >
                {byTool.map((row) => (
                  <TableRow key={`${row.kind}:${row.name}`}>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell>
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                        {KIND_LABEL[row.kind] ?? row.kind}
                      </span>
                    </TableCell>
                    <TableCell>{fmt(row.calls)}</TableCell>
                    <TableCell>
                      {row.errors > 0 ? (
                        <span className="text-destructive">
                          {Math.round((row.errors / row.calls) * 100)}% failed
                        </span>
                      ) : (
                        <span className="text-muted-foreground">no errors</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.p95DurationMs > 0
                        ? formatDuration(row.p95DurationMs)
                        : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.sources.map(sourceLabel).join(" · ")}
                    </TableCell>
                  </TableRow>
                ))}
              </PaginatedTable>
            </CardContent>
          </Card>

          {firstRunAt && (
            <p className="text-xs text-muted-foreground">
              Everything above measures {period}. Data has been recorded since{" "}
              {firstRunAt.toLocaleString("en-US")}
              {lastRunAt && ` until ${lastRunAt.toLocaleString("en-US")}`}.
              "Unused" means unused <em>in this period</em>: a capability added
              recently can show up as unused without that meaning anything.
            </p>
          )}
        </>
      )}
    </div>
  );
}
