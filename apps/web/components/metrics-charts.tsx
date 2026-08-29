"use client";

import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { compact, formatDay } from "@/lib/format";
import { SOURCE_COLOR, SOURCE_LABEL, SOURCE_ORDER } from "@/lib/run-sources";
import { cn } from "@/lib/utils";

export { SOURCE_COLOR };

const AXIS = {
  tickLine: false,
  axisLine: false,
  tickMargin: 8,
} as const;

const shortDay = (day: string) => day.slice(5).replace("-", "/");

function TooltipRow({
  color,
  label,
  value,
}: {
  color?: string;
  label: string;
  value: string;
}) {
  return (
    <div className="flex flex-1 items-center gap-2">
      <span
        className="size-2.5 shrink-0 rounded-[2px]"
        style={{ backgroundColor: color }}
      />
      <span className="flex flex-1 items-center justify-between gap-3">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono font-medium tabular-nums text-foreground">
          {value}
        </span>
      </span>
    </div>
  );
}

function DayLabel({ day, note }: { day: string; note?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-medium">{formatDay(day)}</span>
      {note && (
        <span className="font-normal text-muted-foreground">{note}</span>
      )}
    </div>
  );
}

export type RunPoint = {
  day: string;
  total: number;
  errors: number;
} & Record<string, number | string>;

export function RunsChart({
  data,
  sources,
}: {
  data: RunPoint[];
  sources: string[];
}) {
  const ordered = SOURCE_ORDER.filter((source) => sources.includes(source));
  const config: ChartConfig = Object.fromEntries([
    ...ordered.map((source) => [
      source,
      { label: SOURCE_LABEL[source] ?? source, color: SOURCE_COLOR[source] },
    ]),
    ["errors", { label: "Failed", color: "var(--destructive)" }],
  ]);

  return (
    <ChartContainer config={config} className="aspect-auto h-[200px] w-full">
      <ComposedChart data={data} margin={{ left: 4, right: 4, top: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="day"
          {...AXIS}
          minTickGap={28}
          tickFormatter={shortDay}
        />
        <YAxis {...AXIS} width={32} allowDecimals={false} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => (
                <DayLabel
                  day={String(payload?.[0]?.payload?.day ?? "")}
                  note={`${payload?.[0]?.payload?.total ?? 0} runs in total`}
                />
              )}
            />
          }
        />
        {ordered.map((source) => (
          <Bar
            key={source}
            dataKey={source}
            stackId="runs"
            fill={`var(--color-${source})`}
            radius={source === ordered.at(-1) ? [3, 3, 0, 0] : 0}
          />
        ))}
        <Line
          dataKey="errors"
          type="monotone"
          stroke="var(--color-errors)"
          strokeWidth={1.5}
          dot={false}
        />
        <ChartLegend content={<ChartLegendContent />} />
      </ComposedChart>
    </ChartContainer>
  );
}

const SPARKLINE_CONFIG: ChartConfig = {
  runs: { label: "Runs", color: "var(--chart-1)" },
};

export function RunsSparkline({
  data,
  label,
  className,
}: {
  data: Array<{ day: string; runs: number }>;
  label: string;
  className?: string;
}) {
  return (
    <ChartContainer
      config={SPARKLINE_CONFIG}
      className={cn("aspect-auto h-8 w-28", className)}
      role="img"
      aria-label={label}
    >
      <BarChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <XAxis dataKey="day" hide />
        <YAxis hide domain={[0, "dataMax"]} />
        <ReferenceLine y={0} stroke="var(--border)" strokeWidth={1} />
        <Bar
          dataKey="runs"
          fill="var(--color-runs)"
          radius={[1.5, 1.5, 0, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </ChartContainer>
  );
}

export type LatencyPoint = {
  day: string;
  p50: number;
  p95: number;
};

const seconds = (value: number) => `${(value / 1000).toFixed(1)}s`;

export function LatencyChart({ data }: { data: LatencyPoint[] }) {
  const config: ChartConfig = {
    p50: { label: "p50 (the typical run)", color: "var(--chart-1)" },
    p95: { label: "p95 (the slowest 5%)", color: "var(--chart-4)" },
  };

  return (
    <ChartContainer config={config} className="aspect-auto h-[200px] w-full">
      <ComposedChart data={data} margin={{ left: 4, right: 4, top: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="day"
          {...AXIS}
          minTickGap={28}
          tickFormatter={shortDay}
        />
        <YAxis {...AXIS} width={44} tickFormatter={seconds} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value, name, item) => (
                <TooltipRow
                  color={item.color}
                  label={String(config[name as string]?.label ?? name)}
                  value={seconds(Number(value))}
                />
              )}
              labelFormatter={(_, payload) => (
                <DayLabel day={String(payload?.[0]?.payload?.day ?? "")} />
              )}
            />
          }
        />
        <Area
          dataKey="p50"
          type="monotone"
          stroke="var(--color-p50)"
          fill="var(--color-p50)"
          fillOpacity={0.15}
          strokeWidth={1.5}
        />
        <Line
          dataKey="p95"
          type="monotone"
          stroke="var(--color-p95)"
          strokeWidth={1.5}
          dot={false}
        />
        <ChartLegend content={<ChartLegendContent />} />
      </ComposedChart>
    </ChartContainer>
  );
}

export type TokenPoint = {
  day: string;
  input: number;
  output: number;
  total: number;
};

export function TokensChart({ data }: { data: TokenPoint[] }) {
  const config: ChartConfig = {
    input: { label: "Input (prompt + context)", color: "var(--chart-2)" },
    output: { label: "Output (what it generated)", color: "var(--chart-1)" },
  };

  return (
    <ChartContainer config={config} className="aspect-auto h-[200px] w-full">
      <ComposedChart data={data} margin={{ left: 4, right: 4, top: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="day"
          {...AXIS}
          minTickGap={28}
          tickFormatter={shortDay}
        />
        <YAxis {...AXIS} width={44} tickFormatter={compact} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value, name, item) => (
                <TooltipRow
                  color={item.color}
                  label={String(config[name as string]?.label ?? name)}
                  value={compact(Number(value))}
                />
              )}
              labelFormatter={(_, payload) => (
                <DayLabel
                  day={String(payload?.[0]?.payload?.day ?? "")}
                  note={`${compact(Number(payload?.[0]?.payload?.total ?? 0))} tokens in total`}
                />
              )}
            />
          }
        />
        <Bar
          dataKey="input"
          stackId="tokens"
          fill="var(--color-input)"
          radius={0}
        />
        <Bar
          dataKey="output"
          stackId="tokens"
          fill="var(--color-output)"
          radius={[3, 3, 0, 0]}
        />
        <ChartLegend content={<ChartLegendContent />} />
      </ComposedChart>
    </ChartContainer>
  );
}
