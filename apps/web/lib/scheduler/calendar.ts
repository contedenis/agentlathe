import type { ScheduleFrequency } from "@agentlathe/db/constants";
import { Temporal } from "temporal-polyfill";

export type ScheduleTrigger = {
  frequency: ScheduleFrequency;
  timeOfDay: string;
  weekday: number | null;
  startDate: string | null;
  timezone: string;
};

const HOUR_MS = 60 * 60 * 1000;
const SEARCH_DAYS = 400;

function clock(timeOfDay: string): { hour: number; minute: number } {
  const [hour, minute] = timeOfDay.split(":").map(Number);
  return { hour, minute };
}

function matchesDay(trigger: ScheduleTrigger, date: Temporal.PlainDate) {
  switch (trigger.frequency) {
    case "weekdays":
      return date.dayOfWeek <= 5;
    case "weekly":
      return date.dayOfWeek % 7 === trigger.weekday;
    case "monthly": {
      const day = trigger.startDate
        ? Temporal.PlainDate.from(trigger.startDate).day
        : 1;
      return date.day === Math.min(day, date.daysInMonth);
    }
    default:
      return true;
  }
}

function calendarAfter(trigger: ScheduleTrigger, after: Date): Date {
  const { hour, minute } = clock(trigger.timeOfDay);
  let date = Temporal.Instant.fromEpochMilliseconds(after.getTime())
    .toZonedDateTimeISO(trigger.timezone)
    .toPlainDate()
    .subtract({ days: 1 });
  if (trigger.startDate) {
    const start = Temporal.PlainDate.from(trigger.startDate);
    if (Temporal.PlainDate.compare(date, start) < 0) date = start;
  }
  for (let i = 0; i < SEARCH_DAYS; i++, date = date.add({ days: 1 })) {
    if (!matchesDay(trigger, date)) continue;
    const at = date.toZonedDateTime({
      timeZone: trigger.timezone,
      plainTime: { hour, minute },
    });
    if (at.epochMilliseconds > after.getTime())
      return new Date(at.epochMilliseconds);
  }
  throw new Error("No occurrence found within a year.");
}

export function firstOccurrence(trigger: ScheduleTrigger, from: Date): Date {
  return calendarAfter(trigger, from);
}

export function nextOccurrence(trigger: ScheduleTrigger, previous: Date): Date {
  if (trigger.frequency !== "hourly") return calendarAfter(trigger, previous);
  const earliest = previous.getTime() + HOUR_MS;
  const { minute } = clock(trigger.timeOfDay);
  let at = Temporal.Instant.fromEpochMilliseconds(earliest).toZonedDateTimeISO(
    trigger.timezone,
  );
  for (;;) {
    const candidate = at.with({
      minute,
      second: 0,
      millisecond: 0,
      microsecond: 0,
      nanosecond: 0,
    });
    if (candidate.epochMilliseconds >= earliest)
      return new Date(candidate.epochMilliseconds);
    at = at.add({ hours: 1 });
  }
}

export function upcoming(
  trigger: ScheduleTrigger,
  from: Date,
  count: number,
): Date[] {
  const dates: Date[] = [];
  for (let i = 0; i < count; i++)
    dates.push(
      i === 0
        ? firstOccurrence(trigger, from)
        : nextOccurrence(trigger, dates[i - 1]),
    );
  return dates;
}

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export function describeTrigger(trigger: {
  frequency: string;
  timeOfDay: string;
  weekday: number | null;
  startDate: string | null;
}): string {
  const { timeOfDay } = trigger;
  switch (trigger.frequency) {
    case "hourly":
      return `Every hour at :${timeOfDay.slice(3)}`;
    case "weekdays":
      return `Weekdays at ${timeOfDay}`;
    case "weekly":
      return `Every ${WEEKDAY_NAMES[trigger.weekday ?? 0]} at ${timeOfDay}`;
    case "monthly":
      return `Monthly on day ${trigger.startDate ? Temporal.PlainDate.from(trigger.startDate).day : 1} at ${timeOfDay}`;
    default:
      return `Daily at ${timeOfDay}`;
  }
}

export const INPUT_VARIABLES = [
  "date",
  "datetime",
  "nominal_at",
  "last_success_at",
  "schedule",
] as const;

export type InputContext = {
  scheduleName: string;
  timezone: string;
  nominalAt: Date;
  lastSuccessAt: Date | null;
};

export function renderInput(template: string, context: InputContext): string {
  const local = Temporal.Instant.fromEpochMilliseconds(
    context.nominalAt.getTime(),
  ).toZonedDateTimeISO(context.timezone);
  const date = local.toPlainDate().toString();
  const time = local.toPlainTime().toString({ smallestUnit: "minute" });
  const values: Record<(typeof INPUT_VARIABLES)[number], string> = {
    date,
    datetime: `${date} ${time} ${context.timezone}`,
    nominal_at: context.nominalAt.toISOString(),
    last_success_at: context.lastSuccessAt?.toISOString() ?? "never",
    schedule: context.scheduleName,
  };
  return template.replace(
    /\{\{\s*([a-z_]+)\s*\}\}/g,
    (match, name: string) => values[name as keyof typeof values] ?? match,
  );
}
