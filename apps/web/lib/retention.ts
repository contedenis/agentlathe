import {
  type AppSettings,
  deleteExpiredAgentRuns,
  deleteExpiredTranscripts,
} from "@agentlathe/db";
import { after } from "next/server";

// TTL enforcement rides page views instead of a cron: call it explicitly, never from a read.
export function scheduleRetentionSweep(settings: AppSettings): void {
  after(async () => {
    try {
      await deleteExpiredAgentRuns(settings.agentRunTtlDays);
    } catch (err) {
      console.error("deleteExpiredAgentRuns failed", err);
    }
  });
  after(async () => {
    try {
      await deleteExpiredTranscripts(settings.transcriptTtlDays);
    } catch (err) {
      console.error("deleteExpiredTranscripts failed", err);
    }
  });
}
