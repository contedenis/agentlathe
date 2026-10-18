import {
  type AppSettings,
  deleteExpiredAgentRuns,
  deleteExpiredTranscripts,
} from "@agentlathe/db";
import { after } from "next/server";

export async function runRetentionSweep(settings: AppSettings): Promise<void> {
  const [runs, transcripts] = await Promise.allSettled([
    deleteExpiredAgentRuns(settings.agentRunTtlDays),
    deleteExpiredTranscripts(settings.transcriptTtlDays),
  ]);
  if (runs.status === "rejected")
    console.error("deleteExpiredAgentRuns failed", runs.reason);
  if (transcripts.status === "rejected")
    console.error("deleteExpiredTranscripts failed", transcripts.reason);
}

// TTL enforcement rides page views and the scheduler's tick: call it explicitly, never from a read.
export function scheduleRetentionSweep(settings: AppSettings): void {
  after(() => runRetentionSweep(settings));
}
