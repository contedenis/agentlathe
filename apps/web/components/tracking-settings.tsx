"use client";

import type { AgentRunSource } from "@agentlathe/db/constants";
import { SlidersHorizontalIcon } from "lucide-react";
import {
  type AppSettings,
  SOURCES,
  TrackingToggles,
} from "@/components/tracking-toggles";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
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

export function TrackingSettings({
  settings,
  judgeHost,
}: {
  settings: AppSettings;
  judgeHost: string;
}) {
  const active = SOURCES.filter((source) => settings[source.key]);

  return (
    <Popover>
      <PopoverTrigger
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
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-3 p-4">
        <PopoverHeader>
          <PopoverTitle>What to record</PopoverTitle>
          <PopoverDescription>
            One row per run. Messages are stored too: always for the Playground
            and schedules, and for API and MCP calls only on agents that opt in.
          </PopoverDescription>
        </PopoverHeader>
        <TrackingToggles initial={settings} judgeHost={judgeHost} />
      </PopoverContent>
    </Popover>
  );
}
