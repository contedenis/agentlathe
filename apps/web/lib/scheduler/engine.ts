import {
  agentMcpTools,
  agents,
  db,
  mcpServers,
  type ScheduleOccurrenceStatus,
  scheduleOccurrences,
  schedules,
  settings,
} from "@agentlathe/db";
import {
  type AgentRunStats,
  buildAuth,
  buildScheduledToolApproval,
  generateWithApprovals,
  loadActiveAgent,
} from "@agentlathe/runner";
import { and, eq, inArray, lt, lte, max, sql } from "drizzle-orm";
import { createLimiter } from "../limiter";
import { createRecorder } from "../run-recorder";
import { nextOccurrence, renderInput, type ScheduleTrigger } from "./calendar";

export const MISSED_GRACE_MS = 2 * 60 * 1000;
export const HEARTBEAT_MS = 30 * 1000;
export const STALE_AFTER_MS = 3 * 60 * 1000;
export const MAX_CONSECUTIVE_FAILURES = 5;
const CONCURRENCY = 3;
const CLAIM_BATCH = 50;

const limit = createLimiter(CONCURRENCY);

type Claim = {
  occurrenceId: string;
  scheduleId: string;
  scheduleName: string;
  agentId: string;
  input: string;
  timezone: string;
  nominalAt: Date;
};

export type Execution = { occurrenceId: string; done: Promise<void> };

type Outcome = {
  status: Extract<
    ScheduleOccurrenceStatus,
    "succeeded" | "failed" | "interrupted"
  >;
  reason: string | null;
  runId: string | null;
};

const errorMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export async function tick(signal: AbortSignal): Promise<Execution[]> {
  await Promise.all([recordSchedulerHeartbeat(), reapStaleOccurrences()]);
  const claims = await claimDue();
  return claims.map((claim) => ({
    occurrenceId: claim.occurrenceId,
    done: dispatch(claim, signal),
  }));
}

async function recordSchedulerHeartbeat(): Promise<void> {
  await db
    .insert(settings)
    .values({ id: "singleton", schedulerHeartbeatAt: sql`now()` })
    .onConflictDoUpdate({
      target: settings.id,
      set: { schedulerHeartbeatAt: sql`now()` },
    });
}

async function reapStaleOccurrences(): Promise<void> {
  await db
    .update(scheduleOccurrences)
    .set({
      status: "interrupted",
      reason: "The scheduler stopped while the run was in progress.",
      finishedAt: sql`now()`,
    })
    .where(
      and(
        eq(scheduleOccurrences.status, "running"),
        lt(
          scheduleOccurrences.heartbeatAt,
          sql`now() - make_interval(secs => ${STALE_AFTER_MS / 1000})`,
        ),
      ),
    );
}

function preflight(
  agentActive: boolean,
  servers: { name: string; authConfig: unknown }[],
): string | null {
  if (!agentActive) return "The agent is inactive.";
  if (!process.env.PROVIDER_API_KEY) return "PROVIDER_API_KEY is not set.";
  for (const server of servers) {
    try {
      buildAuth(server.authConfig);
    } catch (err) {
      return `MCP server "${server.name}": ${errorMessage(err)}`;
    }
  }
  return null;
}

function failureAccounting(failed: boolean) {
  const failures = sql`${schedules.consecutiveFailures} + 1`;
  const pauses = sql`${failures} >= ${MAX_CONSECUTIVE_FAILURES}`;
  return failed
    ? {
        consecutiveFailures: failures,
        isActive: sql`case when ${pauses} then false else ${schedules.isActive} end`,
        pausedReason: sql`case when ${pauses} then ${`Paused after ${MAX_CONSECUTIVE_FAILURES} consecutive failures.`} else ${schedules.pausedReason} end`,
      }
    : { consecutiveFailures: 0 };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function mcpServersOf(tx: Tx, agentIds: string[]) {
  return tx
    .selectDistinct({
      agentId: agentMcpTools.agentId,
      name: mcpServers.name,
      authConfig: mcpServers.authConfig,
    })
    .from(agentMcpTools)
    .innerJoin(mcpServers, eq(mcpServers.id, agentMcpTools.serverId))
    .where(
      and(
        inArray(agentMcpTools.agentId, agentIds),
        eq(mcpServers.isActive, true),
      ),
    );
}

async function runningAmong(tx: Tx, scheduleIds: string[]) {
  const rows = await tx
    .selectDistinct({ scheduleId: scheduleOccurrences.scheduleId })
    .from(scheduleOccurrences)
    .where(
      and(
        inArray(scheduleOccurrences.scheduleId, scheduleIds),
        eq(scheduleOccurrences.status, "running"),
      ),
    );
  return new Set(rows.map((row) => row.scheduleId));
}

export type RunNowResult =
  | { status: "not_found" | "busy" }
  | { status: "blocked"; occurrenceId: string; reason: string }
  | { status: "started"; occurrenceId: string; done: Promise<void> };

export async function runNow(scheduleId: string): Promise<RunNowResult> {
  const decision = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ schedule: schedules, agentActive: agents.isActive })
      .from(schedules)
      .innerJoin(agents, eq(agents.id, schedules.agentId))
      .where(eq(schedules.id, scheduleId))
      .for("update", { of: schedules });
    if (!row) return { status: "not_found" as const };
    if ((await runningAmong(tx, [scheduleId])).size > 0)
      return { status: "busy" as const };

    const { schedule } = row;
    const blocked = preflight(
      row.agentActive,
      await mcpServersOf(tx, [schedule.agentId]),
    );
    const [occurrence] = await tx
      .insert(scheduleOccurrences)
      .values({
        scheduleId,
        nominalAt: sql`now()`,
        status: blocked ? "blocked_preflight" : "running",
        reason: blocked,
        heartbeatAt: blocked ? null : sql`now()`,
        finishedAt: blocked ? sql`now()` : null,
      })
      .returning({
        id: scheduleOccurrences.id,
        nominalAt: scheduleOccurrences.nominalAt,
      });
    if (blocked) {
      await tx
        .update(schedules)
        .set(failureAccounting(true))
        .where(eq(schedules.id, scheduleId));
      return {
        status: "blocked" as const,
        occurrenceId: occurrence.id,
        reason: blocked,
      };
    }
    return {
      status: "started" as const,
      claim: {
        occurrenceId: occurrence.id,
        scheduleId,
        scheduleName: schedule.name,
        agentId: schedule.agentId,
        input: schedule.input,
        timezone: schedule.timezone,
        nominalAt: occurrence.nominalAt,
      },
    };
  });
  if (decision.status !== "started") return decision;
  return {
    status: "started",
    occurrenceId: decision.claim.occurrenceId,
    done: dispatch(decision.claim, new AbortController().signal),
  };
}

async function claimDue(): Promise<Claim[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({
        schedule: schedules,
        agentActive: agents.isActive,
        now: sql`now()`.mapWith(schedules.createdAt),
      })
      .from(schedules)
      .innerJoin(agents, eq(agents.id, schedules.agentId))
      .where(
        and(eq(schedules.isActive, true), lte(schedules.nextRunAt, sql`now()`)),
      )
      .orderBy(schedules.nextRunAt)
      .limit(CLAIM_BATCH)
      .for("update", { of: schedules, skipLocked: true });
    if (due.length === 0) return [];

    const servers = await mcpServersOf(tx, [
      ...new Set(due.map((row) => row.schedule.agentId)),
    ]);
    const stillRunning = await runningAmong(
      tx,
      due.map((row) => row.schedule.id),
    );

    const decisions = due.map(({ schedule, agentActive, now }) => {
      const nominalAt = schedule.nextRunAt as Date;
      const trigger = schedule as ScheduleTrigger;
      let next = nextOccurrence(trigger, nominalAt);
      while (next <= now) next = nextOccurrence(trigger, next);

      const blocked = preflight(
        agentActive,
        servers.filter((server) => server.agentId === schedule.agentId),
      );
      const [status, reason]: [ScheduleOccurrenceStatus, string | null] =
        now.getTime() - nominalAt.getTime() > MISSED_GRACE_MS
          ? [
              "skipped_missed",
              `Due at ${nominalAt.toISOString()}, but no scheduler was running until ${now.toISOString()}.`,
            ]
          : stillRunning.has(schedule.id)
            ? ["skipped_overlap", "The previous run was still in progress."]
            : blocked
              ? ["blocked_preflight", blocked]
              : ["running", null];
      return { schedule, nominalAt, next, status, reason };
    });

    const inserted = await tx
      .insert(scheduleOccurrences)
      .values(
        decisions.map(({ schedule, nominalAt, status, reason }) => ({
          scheduleId: schedule.id,
          nominalAt,
          status,
          reason,
          heartbeatAt: status === "running" ? sql`now()` : null,
          finishedAt: status === "running" ? null : sql`now()`,
        })),
      )
      .onConflictDoNothing({
        target: [scheduleOccurrences.scheduleId, scheduleOccurrences.nominalAt],
      })
      .returning({
        id: scheduleOccurrences.id,
        scheduleId: scheduleOccurrences.scheduleId,
      });
    for (const { schedule, next, status } of decisions)
      await tx
        .update(schedules)
        .set({
          nextRunAt: next,
          updatedAt: sql`now()`,
          ...(status === "blocked_preflight" ? failureAccounting(true) : {}),
        })
        .where(eq(schedules.id, schedule.id));

    const occurrenceOf = new Map(
      inserted.map((row) => [row.scheduleId, row.id]),
    );
    return decisions.flatMap(({ schedule, nominalAt, status }) => {
      const occurrenceId = occurrenceOf.get(schedule.id);
      if (!occurrenceId || status !== "running") return [];
      return [
        {
          occurrenceId,
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          agentId: schedule.agentId,
          input: schedule.input,
          timezone: schedule.timezone,
          nominalAt,
        },
      ];
    });
  });
}

async function dispatch(claim: Claim, signal: AbortSignal): Promise<void> {
  const heartbeat = setInterval(() => {
    db.update(scheduleOccurrences)
      .set({ heartbeatAt: sql`now()` })
      .where(eq(scheduleOccurrences.id, claim.occurrenceId))
      .catch((err) => console.error("schedule heartbeat failed", err));
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    const outcome = await limit(() => execute(claim, signal)).catch(
      (err): Outcome => ({
        status: "failed",
        reason: errorMessage(err),
        runId: null,
      }),
    );
    await finish(claim, outcome);
  } catch (err) {
    console.error("scheduled run bookkeeping failed", err);
  } finally {
    clearInterval(heartbeat);
  }
}

async function execute(claim: Claim, signal: AbortSignal): Promise<Outcome> {
  if (signal.aborted)
    return {
      status: "interrupted",
      reason: "The scheduler stopped before the run started.",
      runId: null,
    };
  const [agent, [previous]] = await Promise.all([
    loadActiveAgent(claim.agentId),
    db
      .select({ at: max(scheduleOccurrences.nominalAt) })
      .from(scheduleOccurrences)
      .where(
        and(
          eq(scheduleOccurrences.scheduleId, claim.scheduleId),
          eq(scheduleOccurrences.status, "succeeded"),
        ),
      ),
  ]);
  if (!agent)
    return { status: "failed", reason: "The agent is inactive.", runId: null };

  const message = renderInput(claim.input, {
    scheduleName: claim.scheduleName,
    timezone: claim.timezone,
    nominalAt: claim.nominalAt,
    lastSuccessAt: previous?.at ?? null,
  });
  const recorder = createRecorder({
    agent,
    source: "schedule",
    scheduleId: claim.scheduleId,
  });
  let stats: AgentRunStats | undefined;
  try {
    const { text } = await generateWithApprovals(agent, message, {
      abortSignal: signal,
      headlessApproval: buildScheduledToolApproval,
      onStats: (runStats) => {
        stats = runStats;
      },
    });
    const runId = await recorder.record({ stats });
    await recorder.attachTranscript(
      [{ role: "user", content: message }],
      [{ role: "assistant", content: text }],
    );
    return { status: "succeeded", reason: null, runId };
  } catch (err) {
    const runId = await recorder.record({ stats, error: err });
    await recorder.attachTranscript([{ role: "user", content: message }], []);
    return {
      status: signal.aborted ? "interrupted" : "failed",
      reason: errorMessage(err),
      runId,
    };
  }
}

async function finish(claim: Claim, outcome: Outcome): Promise<void> {
  await Promise.all([
    db
      .update(scheduleOccurrences)
      .set({
        status: outcome.status,
        reason: outcome.reason?.slice(0, 500) ?? null,
        runId: outcome.runId,
        finishedAt: sql`now()`,
      })
      .where(eq(scheduleOccurrences.id, claim.occurrenceId)),
    outcome.status === "interrupted"
      ? undefined
      : db
          .update(schedules)
          .set(failureAccounting(outcome.status === "failed"))
          .where(eq(schedules.id, claim.scheduleId)),
  ]);
}

export async function markInterrupted(occurrenceIds: string[]): Promise<void> {
  if (occurrenceIds.length === 0) return;
  await db
    .update(scheduleOccurrences)
    .set({
      status: "interrupted",
      reason: "The scheduler stopped while the run was in progress.",
      finishedAt: sql`now()`,
    })
    .where(
      and(
        inArray(scheduleOccurrences.id, occurrenceIds),
        eq(scheduleOccurrences.status, "running"),
      ),
    );
}
