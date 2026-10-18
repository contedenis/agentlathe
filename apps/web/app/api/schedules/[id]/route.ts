import { db, type ScheduleFrequency, schedules } from "@agentlathe/db";
import { eq } from "drizzle-orm";
import { dbErrorResponse, isUuid, parseBody } from "@/lib/api-helpers";
import { firstOccurrence } from "@/lib/scheduler/calendar";
import {
  normalizeTrigger,
  scheduleUpdateSchema,
  TRIGGER_FIELDS,
} from "../schema";

async function findSchedule(id: string) {
  const [row] = await db
    .select()
    .from(schedules)
    .where(eq(schedules.id, id))
    .limit(1);
  return row;
}

const notFound = () =>
  Response.json({ error: "Schedule not found." }, { status: 404 });
const invalidId = () =>
  Response.json({ error: "Invalid id." }, { status: 400 });

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) return invalidId();
  const row = await findSchedule(id);
  return row ? Response.json(row) : notFound();
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) return invalidId();

  const parsed = await parseBody(req, scheduleUpdateSchema);
  if ("error" in parsed) return parsed.error;
  const existing = await findSchedule(id);
  if (!existing) return notFound();

  const patch = parsed.data;
  const merged = {
    ...existing,
    ...patch,
    frequency: (patch.frequency ?? existing.frequency) as ScheduleFrequency,
  };
  const trigger = normalizeTrigger(merged);
  if ("error" in trigger)
    return Response.json({ error: trigger.error }, { status: 400 });

  const reactivated = patch.isActive === true && !existing.isActive;
  const triggerChanged = TRIGGER_FIELDS.some((field) => field in patch);
  const nextRunAt = !merged.isActive
    ? null
    : triggerChanged || reactivated || existing.nextRunAt === null
      ? firstOccurrence({ ...merged, ...trigger }, new Date())
      : existing.nextRunAt;

  try {
    const [row] = await db
      .update(schedules)
      .set({
        ...patch,
        ...trigger,
        nextRunAt,
        ...(reactivated ? { consecutiveFailures: 0, pausedReason: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schedules.id, id))
      .returning();
    return row ? Response.json(row) : notFound();
  } catch (err) {
    return dbErrorResponse(err);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) return invalidId();
  const [row] = await db
    .delete(schedules)
    .where(eq(schedules.id, id))
    .returning();
  return row ? new Response(null, { status: 204 }) : notFound();
}
