import { formatDay } from "./format";

export const METRICS_PRESETS = [7, 30, 90] as const;
export type MetricsPreset = (typeof METRICS_PRESETS)[number];
export const MAX_RANGE_DAYS = 366;

const DAY_MS = 86_400_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type MetricsRange = {
  from: string;
  to: string;
  since: Date;
  until: Date;
  days: string[];
  preset: MetricsPreset | null;
};

export type MetricsRangeParams = {
  days?: string;
  from?: string;
  to?: string;
};

const toDay = (date: Date) => date.toISOString().slice(0, 10);
const dayStart = (day: string) => new Date(`${day}T00:00:00.000Z`);
const dayEnd = (day: string) => new Date(`${day}T23:59:59.999Z`);

function shiftDays(day: string, amount: number): string {
  return toDay(new Date(dayStart(day).getTime() + amount * DAY_MS));
}

function isDay(raw: string | undefined): raw is string {
  if (!raw || !DAY_PATTERN.test(raw)) return false;
  const parsed = dayStart(raw);
  return !Number.isNaN(parsed.getTime()) && toDay(parsed) === raw;
}

function toPreset(raw: string | undefined): MetricsPreset {
  const parsed = Number(raw);
  return (METRICS_PRESETS as readonly number[]).includes(parsed)
    ? (parsed as MetricsPreset)
    : 30;
}

function build(
  from: string,
  to: string,
  preset: MetricsPreset | null,
): MetricsRange {
  const since = dayStart(from);
  const length =
    Math.round((dayStart(to).getTime() - since.getTime()) / DAY_MS) + 1;
  return {
    from,
    to,
    since,
    until: dayEnd(to),
    days: Array.from({ length }, (_, index) => shiftDays(from, index)),
    preset,
  };
}

export function parseMetricsRange(params: MetricsRangeParams): MetricsRange {
  const today = toDay(new Date());

  if (!isDay(params.from) && !isDay(params.to)) {
    const preset = toPreset(params.days);
    return build(shiftDays(today, 1 - preset), today, preset);
  }

  let to = isDay(params.to) ? params.to : today;
  let from = isDay(params.from) ? params.from : to;
  if (from > to) {
    const swap = from;
    from = to;
    to = swap;
  }
  if (to > today) to = today;
  if (from > to) from = to;
  const earliest = shiftDays(to, 1 - MAX_RANGE_DAYS);
  if (from < earliest) from = earliest;

  return build(from, to, null);
}

export function previousRangeStart(range: MetricsRange): Date {
  return new Date(range.since.getTime() - range.days.length * DAY_MS);
}

export function rangeQuery(range: MetricsRange): string {
  return range.preset
    ? `days=${range.preset}`
    : `from=${range.from}&to=${range.to}`;
}

export function rangeHref(basePath: string, range: MetricsRange): string {
  return `${basePath}?${rangeQuery(range)}`;
}

export function todayDay(): string {
  return toDay(new Date());
}

export function periodLabel(range: MetricsRange): string {
  const rangeDays = range.days.length;
  return range.preset !== null
    ? `the last ${rangeDays} days`
    : `${formatDay(range.from)} to ${formatDay(range.to)} (${rangeDays} days)`;
}
