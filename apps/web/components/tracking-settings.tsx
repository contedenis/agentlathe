"use client";

import type { AgentRunSource } from "@agentlathe/db/constants";
import { SlidersHorizontalIcon } from "lucide-react";
import Link from "next/link";
import { type AppSettings, SOURCES } from "@/components/tracking-toggles";
import { SOURCE_COLOR } from "@/lib/run-sources";
import { cn } from "@/lib/utils";

const SETTING_KEY_TO_SOURCE: Record<
  (typeof SOURCES)[number]["key"],
  AgentRunSource
> = {
  trackDashboardRuns: "dashboard",
  trackV1Runs: "v1",
  trackMcpRuns: "mcp",
  trackScheduleRuns: "schedule",
};

export function TrackingSettings({ settings }: { settings: AppSettings }) {
  const active = SOURCES.filter((source) => settings[source.key]);

  return (
    <Link
      href="/settings"
      title="What to record: open Settings"
      className={cn(
        "flex items-center gap-2 rounded-lg border bg-card px-2.5 py-[7px] text-[11px] transition-colors hover:text-foreground",
        active.length === 0 ? "text-warning" : "text-muted-foreground",
      )}
    >
      <SlidersHorizontalIcon className="size-3.5" />
      <span className="font-mono">
        {active.length === 0
          ? "not recording"
          : `${active.length}/${SOURCES.length} sources`}
      </span>
      <span className="flex items-center gap-1">
        {SOURCES.map((source) => (
          <span
            key={source.key}
            className="size-1.5 rounded-full"
            style={{
              backgroundColor: settings[source.key]
                ? SOURCE_COLOR[SETTING_KEY_TO_SOURCE[source.key]]
                : "var(--border)",
            }}
          />
        ))}
      </span>
    </Link>
  );
}
