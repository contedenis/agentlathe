import type { ReactNode } from "react";
import { MetricHint } from "@/components/metric-hint";

export const KIND_LABEL: Record<string, string> = {
  tool: "tool",
  mcp: "mcp",
  sub_agent: "sub-agent",
  skill: "skill",
};

export function Trend({
  recent,
  previous,
  days,
  comparable,
}: {
  recent: number;
  previous: number;
  days: number;
  comparable: boolean;
}) {
  if (!comparable)
    return (
      <span className="text-muted-foreground">
        no data for the previous {days} d
      </span>
    );
  if (previous === 0)
    return (
      <span className="text-success">not in use in the previous {days} d</span>
    );
  const change = Math.round(((recent - previous) / previous) * 100);
  if (Math.abs(change) < 10)
    return (
      <span className="text-muted-foreground">
        flat vs the previous {days} d
      </span>
    );
  return (
    <span className={change > 0 ? "text-success" : "text-warning"}>
      {change > 0 ? "↑" : "↓"} {Math.abs(change)}% vs the previous {days} d
    </span>
  );
}

export function Stat({
  label,
  value,
  sub,
  hint,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-card px-4 pt-[15px] pb-[14px]">
      <div className="font-mono text-[10.5px] font-medium tracking-[0.16em] text-faint uppercase">
        {hint ? <MetricHint label={label}>{hint}</MetricHint> : label}
      </div>
      <div className="mt-1.5 font-heading text-2xl">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
