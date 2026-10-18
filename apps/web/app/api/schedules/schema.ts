import {
  SCHEDULE_FREQUENCIES,
  type ScheduleFrequency,
} from "@agentlathe/db/constants";
import { z } from "zod";

function isTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const fields = {
  agentId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  frequency: z.enum(SCHEDULE_FREQUENCIES),
  timeOfDay: z
    .string()
    .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "must be HH:MM, 24-hour"),
  weekday: z.number().int().min(0).max(6).nullable().optional(),
  startDate: z.iso.date().nullable().optional(),
  timezone: z.string().refine(isTimeZone, "must be an IANA time zone"),
  input: z.string().trim().min(1).max(20000),
  isActive: z.boolean().optional(),
};

export const scheduleCreateSchema = z.object(fields);

export const scheduleUpdateSchema = z
  .object(fields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Send at least one field.",
  });

export const TRIGGER_FIELDS = [
  "frequency",
  "timeOfDay",
  "weekday",
  "startDate",
  "timezone",
] as const;

export function normalizeTrigger(trigger: {
  frequency: ScheduleFrequency;
  weekday?: number | null;
  startDate?: string | null;
}): { weekday: number | null; startDate: string | null } | { error: string } {
  if (trigger.frequency === "weekly" && trigger.weekday == null)
    return { error: "A weekly schedule needs a weekday." };
  if (trigger.frequency === "monthly" && !trigger.startDate)
    return { error: "A monthly schedule needs a start date." };
  return {
    weekday: trigger.frequency === "weekly" ? (trigger.weekday ?? null) : null,
    startDate:
      trigger.frequency === "monthly" ? (trigger.startDate ?? null) : null,
  };
}
