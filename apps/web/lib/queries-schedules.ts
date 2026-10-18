import {
  agents,
  db,
  isUuid,
  scheduleOccurrences,
  schedules,
  settings,
} from "@agentlathe/db";
import { desc, eq, getTableColumns, sql } from "drizzle-orm";

const OCCURRENCE_HISTORY = 100;

const occurrenceColumns = {
  id: scheduleOccurrences.id,
  scheduleId: scheduleOccurrences.scheduleId,
  nominalAt: scheduleOccurrences.nominalAt,
  status: scheduleOccurrences.status,
  reason: scheduleOccurrences.reason,
  runId: scheduleOccurrences.runId,
  startedAt: scheduleOccurrences.startedAt,
  finishedAt: scheduleOccurrences.finishedAt,
};

export async function listSchedules() {
  const [rows, latest] = await Promise.all([
    db
      .select({ ...getTableColumns(schedules), agentName: agents.name })
      .from(schedules)
      .innerJoin(agents, eq(agents.id, schedules.agentId))
      .orderBy(desc(schedules.createdAt)),
    db
      .selectDistinctOn([scheduleOccurrences.scheduleId], occurrenceColumns)
      .from(scheduleOccurrences)
      .orderBy(
        scheduleOccurrences.scheduleId,
        desc(scheduleOccurrences.nominalAt),
      ),
  ]);
  const lastOf = new Map(latest.map((row) => [row.scheduleId, row]));
  return rows.map((row) => ({
    ...row,
    lastOccurrence: lastOf.get(row.id) ?? null,
  }));
}

export type ScheduleListRow = Awaited<ReturnType<typeof listSchedules>>[number];

export function listScheduleOccurrences(scheduleId: string) {
  return db
    .select(occurrenceColumns)
    .from(scheduleOccurrences)
    .where(eq(scheduleOccurrences.scheduleId, scheduleId))
    .orderBy(desc(scheduleOccurrences.nominalAt))
    .limit(OCCURRENCE_HISTORY);
}

export type ScheduleOccurrenceRow = Awaited<
  ReturnType<typeof listScheduleOccurrences>
>[number];

export async function getScheduleDetail(id: string) {
  if (!isUuid(id)) return null;
  const [[schedule], occurrences] = await Promise.all([
    db
      .select({ ...getTableColumns(schedules), agentName: agents.name })
      .from(schedules)
      .innerJoin(agents, eq(agents.id, schedules.agentId))
      .where(eq(schedules.id, id))
      .limit(1),
    listScheduleOccurrences(id),
  ]);
  return schedule ? { ...schedule, occurrences } : null;
}

export async function getSchedulerStatus() {
  const [row] = await db
    .select({
      lastTickAt: settings.schedulerHeartbeatAt,
      secondsAgo: sql<
        number | null
      >`extract(epoch from now() - ${settings.schedulerHeartbeatAt})::int`,
    })
    .from(settings)
    .limit(1);
  return row ?? { lastTickAt: null, secondsAgo: null };
}

export function listAgentSchedules(agentId: string) {
  if (!isUuid(agentId)) return Promise.resolve([]);
  return db
    .select({
      id: schedules.id,
      name: schedules.name,
      frequency: schedules.frequency,
      timeOfDay: schedules.timeOfDay,
      weekday: schedules.weekday,
      startDate: schedules.startDate,
      timezone: schedules.timezone,
      isActive: schedules.isActive,
      pausedReason: schedules.pausedReason,
      nextRunAt: schedules.nextRunAt,
    })
    .from(schedules)
    .where(eq(schedules.agentId, agentId))
    .orderBy(schedules.name);
}
