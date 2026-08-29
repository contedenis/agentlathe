import {
  ActivityIcon,
  ArrowUpRightIcon,
  BotIcon,
  LayersIcon,
  PlusIcon,
} from "lucide-react";
import Link from "next/link";
import type { ComponentType } from "react";
import { MetricHint } from "@/components/metric-hint";
import { RunsSparkline } from "@/components/metrics-charts";
import { RunStatusBadge } from "@/components/run-status-badge";
import { Button } from "@/components/ui/button";
import { getDashboardData } from "@/lib/queries";
import { sourceLabel } from "@/lib/run-sources";

function formatRelative(date: Date | null): string {
  if (!date) return "—";
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function StatCard({
  href,
  label,
  value,
  sub,
  icon: Icon,
}: {
  href: string;
  label: string;
  value: number;
  sub?: string;
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <Link
      href={href}
      className="rounded-lg border bg-card px-4 pt-[15px] pb-[14px] transition-colors hover:border-foreground/20"
    >
      <div className="flex items-center gap-[7px] font-mono text-[10.5px] font-medium tracking-[0.16em] text-faint uppercase">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className="mt-[10px] font-mono text-[27px] font-semibold tracking-[-0.03em] tabular-nums">
        {value}
      </div>
      {sub && (
        <div className="mt-1 text-[11.5px] text-muted-foreground">{sub}</div>
      )}
    </Link>
  );
}

function runsByDay(daily: { day: string; runs: number }[]) {
  const byDay = new Map(daily.map((row) => [row.day, row.runs]));
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - (6 - i));
    const day = date.toISOString().slice(0, 10);
    return { day, runs: byDay.get(day) ?? 0 };
  });
}

export default async function Home() {
  const { counts, needsReview, needsReviewCount, agentIssues, activity } =
    await getDashboardData();

  const attentionCount = agentIssues.length;
  const resourceTotal = counts.tools + counts.skills + counts.mcp;
  const failedRate =
    activity.runs > 0 ? Math.round((activity.errors / activity.runs) * 100) : 0;
  const activitySeries = runsByDay(activity.daily);

  return (
    <div>
      <div className="mb-[22px] flex flex-wrap items-end justify-between gap-[20px]">
        <div>
          <p className="font-mono text-[10.5px] font-medium tracking-[0.16em] text-faint uppercase">
            Workshop · overview
          </p>
          <h1 className="mt-1 text-[25px] font-semibold tracking-[-0.025em]">
            Home
          </h1>
          <p className="mt-[3px] text-[13.5px] text-muted-foreground">
            {counts.activeAgents} of {counts.agents} agents active
            {attentionCount > 0
              ? ` · ${attentionCount} with a broken setup`
              : " · all clear"}
          </p>
        </div>
        <Button nativeButton={false} render={<Link href="/agents/new" />}>
          <PlusIcon />
          New agent
        </Button>
      </div>

      <div className="mb-[26px] grid grid-cols-2 gap-[14px] lg:grid-cols-3">
        <StatCard
          href="/agents"
          label="Active agents"
          value={counts.activeAgents}
          sub={`of ${counts.agents} total`}
          icon={BotIcon}
        />
        <StatCard
          href="/tools"
          label="Resources"
          value={resourceTotal}
          sub={`${counts.tools} tools · ${counts.skills} skills · ${counts.mcp} MCP`}
          icon={LayersIcon}
        />
        <Link
          href="/metrics"
          className="col-span-2 flex flex-col rounded-lg border bg-card px-4 pt-[15px] pb-[14px] transition-colors hover:border-foreground/20 lg:col-span-1"
        >
          <div className="flex items-center gap-[7px] font-mono text-[10.5px] font-medium tracking-[0.16em] text-faint uppercase">
            <ActivityIcon className="size-3.5" />
            Last 7 days
          </div>
          <div className="mt-[10px] flex items-baseline gap-1.5">
            <span className="font-mono text-[27px] font-semibold tracking-[-0.03em] tabular-nums">
              {activity.runs}
            </span>
            <span className="text-[12px] text-muted-foreground">runs</span>
          </div>
          <div className="mt-1 text-[11.5px] text-muted-foreground">
            {activity.runs > 0
              ? `${failedRate}% failed · view metrics`
              : "no runs yet · view metrics"}
          </div>
          <RunsSparkline
            data={activitySeries}
            label="Runs per day over the last 7 days"
            className="mt-3 h-16 w-full"
          />
        </Link>
      </div>

      <div className="grid items-start gap-[18px] lg:grid-cols-[1.35fr_1fr]">
        <section className="overflow-hidden rounded-lg border bg-card">
          <header className="flex items-center justify-between border-b px-4 py-[13px]">
            <h2 className="text-[13.5px] font-semibold tracking-[-0.01em]">
              <MetricHint label="Broken setup">
                Agents whose configuration points at something disabled — a
                deactivated tool, skill or MCP server. They will keep running,
                just without that capability.
              </MetricHint>
            </h2>
            <span className="font-mono text-[11px] text-faint">
              {attentionCount}
            </span>
          </header>
          {attentionCount === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">
              All clear — every agent points at active resources.
            </p>
          ) : (
            <ul className="divide-y">
              {agentIssues.map((agent) => (
                <li key={agent.id}>
                  <Link
                    href={`/agents/${agent.id}`}
                    className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40"
                  >
                    <span className="w-[3px] shrink-0 self-stretch rounded-[3px] bg-warning" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium">
                        {agent.name} references inactive resources
                      </div>
                      <div className="mt-[1px] text-[12px] text-muted-foreground">
                        {agent.brokenRefs}{" "}
                        {agent.brokenRefs === 1
                          ? "disabled resource"
                          : "disabled resources"}{" "}
                        used by this agent
                      </div>
                    </div>
                    <ArrowUpRightIcon className="size-4 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="overflow-hidden rounded-lg border bg-card">
          <header className="flex items-center justify-between border-b px-4 py-[13px]">
            <h2 className="text-[13.5px] font-semibold tracking-[-0.01em]">
              <MetricHint label="Runs to review">
                Calls that failed, or that somebody left an open note on. This
                is about what happened when the agent ran, not about how it is
                configured.
              </MetricHint>
            </h2>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-faint">
                {needsReviewCount}
              </span>
              <Link
                href="/runs"
                className="inline-flex items-center gap-[3px] text-[12px] text-primary hover:underline"
              >
                All runs
                <ArrowUpRightIcon className="size-3" />
              </Link>
            </div>
          </header>
          {needsReview.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">
              Nothing to review — no failed runs and no open notes.
            </p>
          ) : (
            <ul className="divide-y">
              {needsReview.map((run) => (
                <li key={run.id}>
                  <Link
                    href={`/runs/${run.id}`}
                    className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">
                        {run.agentName}
                        {run.openDrafts > 0 && (
                          <span className="ml-2 text-[12px] font-normal text-primary">
                            {run.openDrafts} open{" "}
                            {run.openDrafts === 1 ? "note" : "notes"}
                          </span>
                        )}
                      </div>
                      <div className="mt-[1px] truncate font-mono text-[12px] text-faint">
                        {sourceLabel(run.source)} ·{" "}
                        {formatRelative(run.createdAt)}
                      </div>
                    </div>
                    <RunStatusBadge status={run.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
