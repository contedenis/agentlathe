import { and, count, eq, inArray } from "drizzle-orm";
import { db } from "./client";
import {
  agentRuns,
  fixDrafts,
  memoryPartitions,
  memoryStores,
  runTranscripts,
  schedules,
} from "./schema";

export type SubjectFootprint = {
  memories: number;
  runs: number;
  transcripts: number;
  schedules: Array<{ id: string; name: string }>;
};

function subjectPartitions(subjectId: string) {
  return and(
    eq(memoryPartitions.partitionKey, subjectId),
    inArray(
      memoryPartitions.storeId,
      db
        .select({ id: memoryStores.id })
        .from(memoryStores)
        .where(eq(memoryStores.scope, "agent_subject")),
    ),
  );
}

function subjectRuns(subjectId: string) {
  return db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.subjectId, subjectId));
}

export async function getSubjectFootprint(
  subjectId: string,
): Promise<SubjectFootprint> {
  const [[memories], [runs], [transcripts], scheduleRows] = await Promise.all([
    db
      .select({ value: count() })
      .from(memoryPartitions)
      .where(subjectPartitions(subjectId)),
    db
      .select({ value: count() })
      .from(agentRuns)
      .where(eq(agentRuns.subjectId, subjectId)),
    db
      .select({ value: count() })
      .from(runTranscripts)
      .where(inArray(runTranscripts.runId, subjectRuns(subjectId))),
    db
      .select({ id: schedules.id, name: schedules.name })
      .from(schedules)
      .where(eq(schedules.subjectId, subjectId))
      .orderBy(schedules.name),
  ]);
  return {
    memories: memories.value,
    runs: runs.value,
    transcripts: transcripts.value,
    schedules: scheduleRows,
  };
}

export async function forgetSubject(
  subjectId: string,
): Promise<Omit<SubjectFootprint, "schedules"> & { schedules: number }> {
  return db.transaction(async (tx) => {
    const memories = await tx
      .delete(memoryPartitions)
      .where(subjectPartitions(subjectId))
      .returning({ storeId: memoryPartitions.storeId });
    const transcripts = await tx
      .delete(runTranscripts)
      .where(inArray(runTranscripts.runId, subjectRuns(subjectId)))
      .returning({ runId: runTranscripts.runId });
    await tx
      .delete(fixDrafts)
      .where(inArray(fixDrafts.runId, subjectRuns(subjectId)));
    const removedSchedules = await tx
      .delete(schedules)
      .where(eq(schedules.subjectId, subjectId))
      .returning({ id: schedules.id });
    const runs = await tx
      .update(agentRuns)
      .set({ subjectId: null, memorySeen: null })
      .where(eq(agentRuns.subjectId, subjectId))
      .returning({ id: agentRuns.id });
    return {
      memories: memories.length,
      runs: runs.length,
      transcripts: transcripts.length,
      schedules: removedSchedules.length,
    };
  });
}
