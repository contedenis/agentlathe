"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import {
  METRICS_PRESETS,
  type MetricsRange,
  todayDay,
} from "@/lib/metrics-range";
import { cn } from "@/lib/utils";

export function MetricsRangePicker({
  basePath,
  range,
}: {
  basePath: string;
  range: MetricsRange;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const today = todayDay();

  const go = (query: string) =>
    startTransition(() => router.push(`${basePath}?${query}`));

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 transition-opacity",
        pending && "opacity-50",
      )}
    >
      <div className="flex items-center gap-1 rounded-lg border bg-card p-0.5">
        {METRICS_PRESETS.map((days) => (
          <button
            key={days}
            type="button"
            onClick={() => go(`days=${days}`)}
            aria-current={range.preset === days ? "page" : undefined}
            className={cn(
              "rounded-md px-2.5 py-1 font-mono text-[11px] transition-colors",
              range.preset === days
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {days} d
          </button>
        ))}
      </div>

      <div
        className={cn(
          "flex items-center gap-1.5 rounded-lg border bg-card px-2 py-1",
          range.preset === null && "border-accent-foreground/30 bg-accent",
        )}
      >
        <input
          type="date"
          aria-label="From"
          value={range.from}
          max={range.to}
          onChange={(event) =>
            event.target.value &&
            go(`from=${event.target.value}&to=${range.to}`)
          }
          className="bg-transparent font-mono text-[11px] outline-none"
        />
        <span className="text-faint">→</span>
        <input
          type="date"
          aria-label="To"
          value={range.to}
          min={range.from}
          max={today}
          onChange={(event) =>
            event.target.value &&
            go(`from=${range.from}&to=${event.target.value}`)
          }
          className="bg-transparent font-mono text-[11px] outline-none"
        />
      </div>
    </div>
  );
}
