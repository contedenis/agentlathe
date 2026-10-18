import type { ScheduleOccurrenceStatus } from "@agentlathe/db/constants";
import { cn } from "@/lib/utils";

const TONE = {
  good: "bg-success/15 text-success",
  bad: "bg-destructive/15 text-destructive",
  warn: "bg-warning/15 text-warning",
  busy: "bg-primary/15 text-primary",
  quiet: "border bg-muted text-muted-foreground",
};

const OCCURRENCE: Record<
  ScheduleOccurrenceStatus,
  { label: string; tone: keyof typeof TONE }
> = {
  running: { label: "running", tone: "busy" },
  succeeded: { label: "succeeded", tone: "good" },
  failed: { label: "failed", tone: "bad" },
  skipped_overlap: { label: "skipped · overlap", tone: "quiet" },
  skipped_missed: { label: "skipped · missed", tone: "quiet" },
  blocked_preflight: { label: "blocked", tone: "warn" },
  interrupted: { label: "interrupted", tone: "warn" },
};

function Pill({ tone, label }: { tone: keyof typeof TONE; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-[9px] py-[2px] font-mono text-[11px] font-medium tracking-[0.01em] whitespace-nowrap",
        TONE[tone],
      )}
    >
      {label}
    </span>
  );
}

export function OccurrenceStatusBadge({ status }: { status: string }) {
  const known = OCCURRENCE[status as ScheduleOccurrenceStatus];
  return <Pill tone={known?.tone ?? "quiet"} label={known?.label ?? status} />;
}

export function ScheduleStateBadge({
  isActive,
  pausedReason,
}: {
  isActive: boolean;
  pausedReason: string | null;
}) {
  if (isActive) return <Pill tone="good" label="active" />;
  return pausedReason ? (
    <Pill tone="warn" label="paused" />
  ) : (
    <Pill tone="quiet" label="inactive" />
  );
}
