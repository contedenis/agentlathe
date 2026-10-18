import { db, schedules } from "@agentlathe/db";
import { dbErrorResponse, parseBody } from "@/lib/api-helpers";
import { listSchedules } from "@/lib/queries-schedules";
import { firstOccurrence } from "@/lib/scheduler/calendar";
import { normalizeTrigger, scheduleCreateSchema } from "./schema";

export async function GET() {
  return Response.json(await listSchedules());
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, scheduleCreateSchema);
  if ("error" in parsed) return parsed.error;

  const trigger = normalizeTrigger(parsed.data);
  if ("error" in trigger)
    return Response.json({ error: trigger.error }, { status: 400 });

  const values = { ...parsed.data, ...trigger };
  const isActive = values.isActive ?? true;
  try {
    const [row] = await db
      .insert(schedules)
      .values({
        ...values,
        isActive,
        nextRunAt: isActive ? firstOccurrence(values, new Date()) : null,
      })
      .returning();
    return Response.json(row, { status: 201 });
  } catch (err) {
    return dbErrorResponse(err);
  }
}
