import { ArrowLeftIcon, ChartNoAxesColumnIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AgentEvaluationMetrics } from "@/components/agent-evaluation-metrics";
import { BreadcrumbTitle } from "@/components/breadcrumb-title";
import { MetricHint } from "@/components/metric-hint";
import {
  LatencyChart,
  RunsChart,
  SOURCE_COLOR,
  TokensChart,
} from "@/components/metrics-charts";
import { KIND_LABEL, Stat, Trend } from "@/components/metrics-primitives";
import { MetricsRangePicker } from "@/components/metrics-range-picker";
import { PageHeader } from "@/components/page-header";
import { PaginatedTable } from "@/components/paginated-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { compact, fmt, formatCost, formatDuration } from "@/lib/format";
import { buildChartPoints } from "@/lib/metrics-assembly";
import {
  type MetricsRangeParams,
  parseMetricsRange,
  periodLabel,
  previousRangeStart,
  rangeHref,
} from "@/lib/metrics-range";
import { estimateCostUsd, getOpenRouterModels } from "@/lib/openrouter-models";
import { getAgentMetricsData } from "@/lib/queries-metrics";
import { sourceLabel } from "@/lib/run-sources";

export default async function AgentMetricsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<MetricsRangeParams>;
}) {
  const [{ id }, rawParams] = await Promise.all([params, searchParams]);
  const range = parseMetricsRange(rawParams);
  const [data, models] = await Promise.all([
    getAgentMetricsData(id, range),
    getOpenRouterModels(),
  ]);
  if (!data) notFound();

  const {
    agent,
    totals,
    daily,
    dailyLatency,
    bySource,
    capabilities,
    parents,
    evaluation,
    recentErrors,
    previousRuns,
    activeDays,
    days,
    firstRunAt,
    lastRunAt,
  } = data;

  const rangeDays = days.length;
  const period = periodLabel(range);

  const { runPoints, latencyPoints, tokenPoints, sources } = buildChartPoints(
    daily,
    dailyLatency,
    days,
  );

  const cost = estimateCostUsd(
    models,
    agent.model,
    totals.inputTokens,
    totals.outputTokens,
  );
  const unused = capabilities.filter(
    (row) => row.configured && row.calls === 0 && row.denied === 0,
  );
  const drifted = capabilities.filter((row) => !row.configured);
  const maxSourceRuns = Math.max(...bySource.map((row) => row.runs), 1);

  return (
    <div className="flex flex-col gap-5">
      <BreadcrumbTitle name={agent.name} />
      <Link
        href={rangeHref("/metrics", range)}
        className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-3.5" />
        All metrics
      </Link>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader
          eyebrow="Agent metrics"
          title={agent.name}
          description={agent.description ?? undefined}
        />
        <MetricsRangePicker basePath={`/metrics/${agent.id}`} range={range} />
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
          {agent.model}
        </span>
        {!agent.isActive && (
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-warning">
            inactive
          </span>
        )}
        <Link
          href={`/agents/${agent.id}`}
          className="text-muted-foreground hover:text-foreground"
        >
          View agent
        </Link>
        <span className="text-faint">·</span>
        <Link
          href={`/agents/${agent.id}/edit`}
          className="text-muted-foreground hover:text-foreground"
        >
          Edit configuration
        </Link>
      </div>

      {totals.runs === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <ChartNoAxesColumnIcon className="size-8 text-faint" />
            <p className="font-medium">This agent had no runs in {period}</p>
            <p className="max-w-md text-sm text-muted-foreground">
              {firstRunAt
                ? `The last recorded run was ${lastRunAt?.toLocaleString("en-US")}.`
                : "No run of this agent was ever recorded. Either nobody uses it, or the source it is invoked through is not being tracked."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label={`Runs (${rangeDays} d)`}
              value={fmt(totals.runs)}
              sub={
                <Trend
                  recent={totals.runs}
                  previous={previousRuns}
                  days={rangeDays}
                  comparable={
                    firstRunAt !== null &&
                    firstRunAt.getTime() <= previousRangeStart(range).getTime()
                  }
                />
              }
            />
            <Stat
              label="Days with use"
              value={`${activeDays}/${rangeDays}`}
              sub={`${Math.round((activeDays / rangeDays) * 100)}% of the days in the period`}
            />
            <Stat
              label="Latency"
              value={formatDuration(totals.p95DurationMs)}
              sub={`typical run ${formatDuration(totals.p50DurationMs)} · ${Math.round((totals.errors / totals.runs) * 100)}% failed`}
            />
            <Stat
              label="Cost"
              value={formatCost(cost)}
              sub={`${compact(totals.tokens)} tokens · ${compact(totals.inputTokens)} in · ${compact(totals.outputTokens)} out`}
            />
          </div>

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
                  The gap between p50 and p95 measures how unpredictable this
                  agent is.
                </p>
              </CardHeader>
              <CardContent>
                <LatencyChart data={latencyPoints} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Tokens per day</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Input grows with the system prompt, the skills and every
                  plugged-in tool.
                </p>
              </CardHeader>
              <CardContent>
                <TokensChart data={tokenPoints} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Where it is invoked from</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                  From the dashboard you are the one testing it. Over the API or
                  MCP somebody else is consuming it.
                </p>
                {bySource.map((row) => (
                  <div key={row.source} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between text-sm">
                      <span className="font-medium">
                        {sourceLabel(row.source)}
                      </span>
                      <span className="text-muted-foreground">
                        {fmt(row.runs)} runs ·{" "}
                        {Math.round((row.runs / totals.runs) * 100)}% · p95{" "}
                        {formatDuration(row.p95DurationMs)}
                        {row.errors > 0 && (
                          <span className="text-destructive">
                            {" "}
                            · {Math.round((row.errors / row.runs) * 100)}% error
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${(row.runs / maxSourceRuns) * 100}%`,
                          backgroundColor:
                            SOURCE_COLOR[row.source] ?? "var(--chart-4)",
                        }}
                      />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          <AgentEvaluationMetrics
            evaluation={evaluation}
            agentId={agent.id}
            period={period}
          />

          {parents.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Who delegates to it</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <p className="text-sm text-muted-foreground">
                  Agents that have it configured as a sub-agent, and how many
                  times they called it during the period.
                </p>
                {parents.map((parent) => (
                  <div
                    key={parent.id}
                    className="flex items-center justify-between gap-4 border-b pb-2 text-sm last:border-0 last:pb-0"
                  >
                    <Link
                      href={rangeHref(`/metrics/${parent.id}`, range)}
                      className="font-medium hover:text-primary"
                    >
                      {parent.name}
                    </Link>
                    <span
                      className={
                        parent.calls === 0
                          ? "text-warning"
                          : "text-muted-foreground"
                      }
                    >
                      {parent.calls === 0
                        ? "configured, never delegated"
                        : `${fmt(parent.calls)} delegations`}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Capabilities</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <p className="px-4 pb-3 text-sm text-muted-foreground">
            Everything it has plugged in, used or not.{" "}
            {unused.length > 0
              ? `${unused.length} of ${capabilities.filter((row) => row.configured).length} were not called in ${period}.`
              : "All of them were called at least once during the period."}
          </p>
          <PaginatedTable
            head={
              <>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>
                  <MetricHint label="Calls">
                    <span>
                      Times this agent executed it. Attempts the user rejected
                      at the approval prompt are not counted: those are in the
                      next column.
                    </span>
                  </MetricHint>
                </TableHead>
                <TableHead>Rejected</TableHead>
                <TableHead>Reliability</TableHead>
                <TableHead>
                  <MetricHint label="Latency">
                    <span>
                      p95 of how long the capability itself takes, not counting
                      the model thinking around it.
                    </span>
                    <span>
                      Calls made from the dashboard chat do not record a
                      duration, so they show a dash.
                    </span>
                  </MetricHint>
                </TableHead>
                <TableHead>Status</TableHead>
              </>
            }
            empty={
              <p className="px-4 pb-4 text-sm text-muted-foreground">
                This agent has no tools, skills, MCP or sub-agents configured.
              </p>
            }
          >
            {capabilities.map((row) => (
              <TableRow key={`${row.kind}:${row.name}`}>
                <TableCell
                  className="font-medium"
                  title={row.displayName !== row.name ? row.name : undefined}
                >
                  {row.displayName}
                </TableCell>
                <TableCell>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {KIND_LABEL[row.kind] ?? row.kind}
                  </span>
                </TableCell>
                <TableCell>{fmt(row.calls)}</TableCell>
                <TableCell>
                  {row.denied > 0 ? (
                    <span className="text-warning">{fmt(row.denied)}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
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
                <TableCell>
                  {!row.configured ? (
                    <span className="text-warning">no longer plugged in</span>
                  ) : row.calls === 0 && row.denied === 0 ? (
                    <span className="text-warning">unused</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </PaginatedTable>
          {(unused.length > 0 || drifted.length > 0) && (
            <div className="border-t px-4 py-3 text-xs text-muted-foreground">
              {unused.length > 0 && (
                <p>
                  Unused capabilities still enter the prompt on every step and
                  compete for the model's attention. Removing them usually
                  improves selection and lowers the bill — unless you added them
                  recently.
                </p>
              )}
              {drifted.length > 0 && (
                <p className="mt-1">
                  {drifted.length} capability(ies) were called during the period
                  but are no longer configured: they were removed after those
                  runs.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {recentErrors.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Recent errors</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {recentErrors.map((row) => (
              <div
                key={row.id}
                className="flex flex-col gap-0.5 border-b pb-2 last:border-0 last:pb-0"
              >
                <div className="flex items-center gap-2 font-mono text-[11px] text-faint">
                  <span>{row.createdAt.toLocaleString("en-US")}</span>
                  <span>{sourceLabel(row.source)}</span>
                </div>
                <p className="text-sm text-destructive">
                  {row.error ?? "no detail"}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {firstRunAt && (
        <p className="text-xs text-muted-foreground">
          Everything above measures {period}. Data for this agent has been
          recorded since {firstRunAt.toLocaleString("en-US")}
          {lastRunAt && ` until ${lastRunAt.toLocaleString("en-US")}`}.
        </p>
      )}
    </div>
  );
}
