import { eq, lt, sql } from "drizzle-orm";
import { db } from "./client";
import {
  DEFAULT_AGENT_RUN_TTL_DAYS,
  DEFAULT_JUDGE_MODEL,
  DEFAULT_TRACK_DASHBOARD_RUNS,
  DEFAULT_TRACK_MCP_RUNS,
  DEFAULT_TRACK_SCHEDULE_RUNS,
  DEFAULT_TRACK_V1_RUNS,
  DEFAULT_TRANSCRIPT_TTL_DAYS,
} from "./constants";
import {
  type AgentRunCallKind,
  type AgentRunSource,
  agentRunCalls,
  agentRuns,
  type MemorySeen,
  type RunWarning,
  runTranscripts,
  settings,
} from "./schema";

export type TrackingFlags = {
  trackDashboardRuns: boolean;
  trackV1Runs: boolean;
  trackMcpRuns: boolean;
  trackScheduleRuns: boolean;
};

export type AppSettings = TrackingFlags & {
  agentRunTtlDays: number;
  transcriptTtlDays: number;
  judgeModel: string;
  builderModel: string | null;
};

const TRACK_COLUMN = {
  dashboard: "trackDashboardRuns",
  v1: "trackV1Runs",
  mcp: "trackMcpRuns",
  schedule: "trackScheduleRuns",
} as const satisfies Record<AgentRunSource, keyof TrackingFlags>;

export function isTrackingEnabled(
  source: AgentRunSource,
  flags: TrackingFlags,
): boolean {
  return flags[TRACK_COLUMN[source]];
}

const DEFAULTS: AppSettings = {
  trackDashboardRuns: DEFAULT_TRACK_DASHBOARD_RUNS,
  trackV1Runs: DEFAULT_TRACK_V1_RUNS,
  trackMcpRuns: DEFAULT_TRACK_MCP_RUNS,
  trackScheduleRuns: DEFAULT_TRACK_SCHEDULE_RUNS,
  agentRunTtlDays: DEFAULT_AGENT_RUN_TTL_DAYS,
  transcriptTtlDays: DEFAULT_TRANSCRIPT_TTL_DAYS,
  judgeModel: DEFAULT_JUDGE_MODEL,
  builderModel: null,
};

export async function getSettings(): Promise<AppSettings> {
  const [row] = await db
    .select({
      trackDashboardRuns: settings.trackDashboardRuns,
      trackV1Runs: settings.trackV1Runs,
      trackMcpRuns: settings.trackMcpRuns,
      trackScheduleRuns: settings.trackScheduleRuns,
      agentRunTtlDays: settings.agentRunTtlDays,
      transcriptTtlDays: settings.transcriptTtlDays,
      judgeModel: settings.judgeModel,
      builderModel: settings.builderModel,
    })
    .from(settings)
    .limit(1);
  return row ?? DEFAULTS;
}

export async function setSettings(
  values: Partial<AppSettings>,
): Promise<AppSettings> {
  const [row] = await db
    .insert(settings)
    .values({ id: "singleton", ...values })
    .onConflictDoUpdate({
      target: settings.id,
      set: { ...values, updatedAt: new Date() },
    })
    .returning({
      trackDashboardRuns: settings.trackDashboardRuns,
      trackV1Runs: settings.trackV1Runs,
      trackMcpRuns: settings.trackMcpRuns,
      trackScheduleRuns: settings.trackScheduleRuns,
      agentRunTtlDays: settings.agentRunTtlDays,
      transcriptTtlDays: settings.transcriptTtlDays,
      judgeModel: settings.judgeModel,
      builderModel: settings.builderModel,
    });
  return row;
}

export type AgentRunCall = {
  kind: AgentRunCallKind;
  name: string;
  durationMs?: number | null;
  status?: "ok" | "error" | "denied";
};

export type AgentRunRecord = {
  agentId: string;
  agentVersionId?: string | null;
  scheduleId?: string | null;
  source: AgentRunSource;
  threadId?: string | null;
  subjectId?: string | null;
  durationMs: number;
  status?: "ok" | "error";
  model?: string | null;
  steps?: number;
  toolCalls?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  approvalsRequested?: number;
  approvalsGranted?: number;
  mcpFailures?: string[];
  warnings?: RunWarning[];
  memorySeen?: MemorySeen[];
  error?: string | null;
  calls?: AgentRunCall[];
};

export async function recordAgentRun(
  record: AgentRunRecord,
): Promise<string | null> {
  try {
    const appSettings = await getSettings();
    if (!isTrackingEnabled(record.source, appSettings)) return null;

    const { calls, ...run } = record;
    const insertedId = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(agentRuns)
        .values({
          ...run,
          durationMs: Math.round(run.durationMs),
          mcpFailures: run.mcpFailures?.length ? run.mcpFailures : null,
          warnings: run.warnings?.length ? run.warnings : null,
          memorySeen: run.memorySeen?.length ? run.memorySeen : null,
          error: run.error?.slice(0, 500) ?? null,
        })
        .returning({ id: agentRuns.id });

      if (!inserted) return null;
      if (calls?.length) {
        await tx.insert(agentRunCalls).values(
          calls.map((call) => ({
            runId: inserted.id,
            kind: call.kind,
            name: call.name.slice(0, 200),
            durationMs:
              call.durationMs == null ? null : Math.round(call.durationMs),
            status: call.status ?? "ok",
          })),
        );
      }
      return inserted.id;
    });
    return insertedId;
  } catch (err) {
    console.error("recordAgentRun failed", err);
    return null;
  }
}

export async function saveRunTranscript(
  runId: string,
  input: unknown,
  output: unknown,
): Promise<boolean> {
  try {
    await db.insert(runTranscripts).values({ runId, input, output });
    return true;
  } catch (err) {
    console.error("saveRunTranscript failed", err);
    return false;
  }
}

export async function deleteExpiredTranscripts(ttlDays: number): Promise<void> {
  if (ttlDays <= 0) return;
  const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000);
  await db.delete(runTranscripts).where(lt(runTranscripts.createdAt, cutoff));
}

export async function deleteExpiredAgentRuns(ttlDays: number): Promise<void> {
  if (ttlDays <= 0) return;
  const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000);
  await db.delete(agentRuns).where(lt(agentRuns.createdAt, cutoff));
}

export async function appendRunWarnings(
  runId: string,
  warnings: RunWarning[],
): Promise<void> {
  if (warnings.length === 0) return;
  await db
    .update(agentRuns)
    .set({
      warnings: sql`coalesce(${agentRuns.warnings}, '[]'::jsonb) || ${JSON.stringify(warnings)}::jsonb`,
    })
    .where(eq(agentRuns.id, runId));
}
