import {
  agentCriteria,
  agentRuns,
  db,
  getSettings,
  type RunEvaluationSkipReason,
  type RunEvaluationStatus,
  runEvaluations,
  runTranscripts,
} from "@agentlathe/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { evaluationInput } from "./evaluation-input";
import { deriveStatus } from "./evaluation-verdict";
import { askJudge, type JudgeQuestion } from "./judge";
import { createLimiter } from "./limiter";

export type CriterionDraft = {
  question: string;
  passDescription: string | null;
  failDescription: string | null;
  appliesWhen: string | null;
  failBelow: number;
  passAbove: number;
};

export type EvaluationOutcome = {
  status: RunEvaluationStatus;
  pPass: number | null;
  pApplies: number | null;
  skipReason: RunEvaluationSkipReason | null;
  error: string | null;
  judgeModel: string | null;
};

type RunLookupFailure =
  | { error: "run_not_found" }
  | { skipped: "no_transcript" };

function questionFor(criterion: CriterionDraft): JudgeQuestion {
  const { question, passDescription, failDescription } = criterion;
  if (passDescription && failDescription)
    return {
      instructions: question,
      criteria: { true: passDescription, false: failDescription },
    };
  const hints = [
    passDescription && `A yes means: ${passDescription}`,
    failDescription && `A no means: ${failDescription}`,
  ].filter(Boolean);
  return { instructions: [question, ...hints].join("\n") };
}

function uniformOutcomes(
  count: number,
  outcome: Omit<EvaluationOutcome, "pPass" | "pApplies" | "judgeModel">,
): EvaluationOutcome[] {
  return Array.from({ length: count }, () => ({
    ...outcome,
    pPass: null,
    pApplies: null,
    judgeModel: null,
  }));
}

async function judgeCriteria(
  input: unknown,
  output: unknown,
  criteria: CriterionDraft[],
  judgeModel: string,
): Promise<EvaluationOutcome[]> {
  const prepared = evaluationInput(input, output);
  if ("awaitingApproval" in prepared)
    return uniformOutcomes(criteria.length, {
      status: "skipped",
      skipReason: "awaiting_approval",
      error: null,
    });

  const questions: Record<string, JudgeQuestion> = {};
  criteria.forEach((criterion, index) => {
    questions[`pass_${index}`] = questionFor(criterion);
    if (criterion.appliesWhen)
      questions[`applies_${index}`] = { instructions: criterion.appliesWhen };
  });

  let judged: Awaited<ReturnType<typeof askJudge>>;
  try {
    judged = await askJudge({
      model: judgeModel,
      state: prepared.state,
      questions,
    });
  } catch (err) {
    return uniformOutcomes(criteria.length, {
      status: "error",
      skipReason: null,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
    });
  }
  if (judged.tooLong)
    return uniformOutcomes(criteria.length, {
      status: "skipped",
      skipReason: "too_long",
      error: null,
    });

  return criteria.map((criterion, index) => {
    const pPass = judged.answers[`pass_${index}`];
    const pApplies = criterion.appliesWhen
      ? judged.answers[`applies_${index}`]
      : null;
    return {
      status: deriveStatus(criterion, pPass, pApplies),
      pPass,
      pApplies,
      skipReason: null,
      error: null,
      judgeModel: judged.model,
    };
  });
}

async function loadRunWithTranscript(runId: string) {
  const [row] = await db
    .select({
      agentId: agentRuns.agentId,
      input: runTranscripts.input,
      output: runTranscripts.output,
      hasTranscript: sql<boolean>`${runTranscripts.runId} is not null`,
    })
    .from(agentRuns)
    .leftJoin(runTranscripts, eq(runTranscripts.runId, agentRuns.id))
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return row;
}

export async function evaluateRun(
  runId: string,
  { criterionIds }: { criterionIds?: string[] } = {},
): Promise<
  | RunLookupFailure
  | { error: "unknown_criteria" }
  | {
      evaluations: (typeof runEvaluations.$inferSelect)[];
      notJudged?: Pick<EvaluationOutcome, "status" | "skipReason" | "error">;
    }
> {
  const [run, criteria, settings] = await Promise.all([
    loadRunWithTranscript(runId),
    db
      .select({ criterion: agentCriteria })
      .from(agentCriteria)
      .innerJoin(agentRuns, eq(agentRuns.agentId, agentCriteria.agentId))
      .where(
        and(
          eq(agentRuns.id, runId),
          criterionIds
            ? inArray(agentCriteria.id, criterionIds)
            : eq(agentCriteria.isActive, true),
        ),
      )
      .orderBy(asc(agentCriteria.createdAt))
      .then((rows) => rows.map((row) => row.criterion)),
    getSettings(),
  ]);

  if (!run) return { error: "run_not_found" };
  if (criterionIds && criteria.length !== new Set(criterionIds).size)
    return { error: "unknown_criteria" };
  if (!run.hasTranscript) return { skipped: "no_transcript" };
  if (criteria.length === 0) return { evaluations: [] };

  const outcomes = await judgeCriteria(
    run.input,
    run.output,
    criteria,
    settings.judgeModel,
  );

  await db
    .insert(runEvaluations)
    .values(
      criteria.map((criterion, index) => ({
        runId,
        criterionId: criterion.id,
        questionSnapshot: criterion.question,
        ...outcomes[index],
      })),
    )
    .onConflictDoUpdate({
      target: [runEvaluations.runId, runEvaluations.criterionId],
      set: {
        questionSnapshot: sql`excluded.question_snapshot`,
        pPass: sql`excluded.p_pass`,
        pApplies: sql`excluded.p_applies`,
        status: sql`excluded.status`,
        skipReason: sql`excluded.skip_reason`,
        error: sql`excluded.error`,
        judgeModel: sql`excluded.judge_model`,
        reviewedVerdict: sql`case when excluded.status in ('error','skipped') or excluded.question_snapshot = ${runEvaluations.questionSnapshot} then ${runEvaluations.reviewedVerdict} else null end`,
        createdAt: sql`now()`,
      },
      setWhere: sql`excluded.status not in ('error','skipped') or ${runEvaluations.status} in ('error','skipped')`,
    });

  const criterionIndex = new Map(
    criteria.map((criterion, index) => [criterion.id, index]),
  );
  const evaluations = (
    await db
      .select()
      .from(runEvaluations)
      .where(
        and(
          eq(runEvaluations.runId, runId),
          inArray(runEvaluations.criterionId, [...criterionIndex.keys()]),
        ),
      )
  ).sort(
    (a, b) =>
      (criterionIndex.get(a.criterionId) ?? 0) -
      (criterionIndex.get(b.criterionId) ?? 0),
  );
  const [{ status, skipReason, error }] = outcomes;
  return status === "error" || status === "skipped"
    ? { evaluations, notJudged: { status, skipReason, error } }
    : { evaluations };
}

export async function previewCriterion(
  runId: string,
  criterion: CriterionDraft,
): Promise<RunLookupFailure | { preview: EvaluationOutcome }> {
  const [run, settings] = await Promise.all([
    loadRunWithTranscript(runId),
    getSettings(),
  ]);
  if (!run) return { error: "run_not_found" };
  if (!run.hasTranscript) return { skipped: "no_transcript" };

  const [preview] = await judgeCriteria(
    run.input,
    run.output,
    [criterion],
    settings.judgeModel,
  );
  return { preview };
}

export async function hasActiveCriteria(agentId: string): Promise<boolean> {
  const [active] = await db
    .select({ id: agentCriteria.id })
    .from(agentCriteria)
    .where(
      and(eq(agentCriteria.agentId, agentId), eq(agentCriteria.isActive, true)),
    )
    .limit(1);
  return Boolean(active);
}

export type RecentEvaluationSummary = Record<
  "pass" | "fail" | "needsReview" | "notApplicable" | "skipped" | "error",
  number
> & {
  runs: number;
  notJudged: number;
  stoppedEarly: "aborted" | "judge_failing" | null;
};

const SUMMARY_KEYS: Record<
  RunEvaluationStatus,
  keyof Omit<RecentEvaluationSummary, "runs" | "notJudged" | "stoppedEarly">
> = {
  pass: "pass",
  fail: "fail",
  needs_review: "needsReview",
  not_applicable: "notApplicable",
  skipped: "skipped",
  error: "error",
};

const RECENT_CONCURRENCY = 4;
const MAX_CONSECUTIVE_JUDGE_FAILURES = 3;

export async function evaluateRecentRuns(
  agentId: string,
  limit: number,
  signal?: AbortSignal,
): Promise<RecentEvaluationSummary> {
  const summary: RecentEvaluationSummary = {
    runs: 0,
    pass: 0,
    fail: 0,
    needsReview: 0,
    notApplicable: 0,
    skipped: 0,
    error: 0,
    notJudged: 0,
    stoppedEarly: null,
  };
  if (!(await hasActiveCriteria(agentId))) return summary;

  const runs = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .innerJoin(runTranscripts, eq(runTranscripts.runId, agentRuns.id))
    .where(eq(agentRuns.agentId, agentId))
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit);
  summary.runs = runs.length;

  let consecutiveFailures = 0;
  const stopReason = () =>
    signal?.aborted
      ? "aborted"
      : consecutiveFailures >= MAX_CONSECUTIVE_JUDGE_FAILURES
        ? "judge_failing"
        : null;

  const evaluateOne = async (runId: string) => {
    const stop = stopReason();
    if (stop) {
      summary.stoppedEarly ??= stop;
      summary.notJudged += 1;
      return;
    }
    try {
      const result = await evaluateRun(runId);
      if (!("evaluations" in result) || result.evaluations.length === 0) {
        summary.notJudged += 1;
        return;
      }
      if (result.notJudged) {
        summary.notJudged += 1;
        summary[SUMMARY_KEYS[result.notJudged.status]] +=
          result.evaluations.length;
        consecutiveFailures =
          result.notJudged.status === "error" ? consecutiveFailures + 1 : 0;
        return;
      }
      consecutiveFailures = 0;
      for (const evaluation of result.evaluations)
        summary[SUMMARY_KEYS[evaluation.status as RunEvaluationStatus]] += 1;
    } catch (err) {
      console.error(`evaluating run ${runId} failed`, err);
      summary.notJudged += 1;
      consecutiveFailures += 1;
    }
  };

  const limited = createLimiter(RECENT_CONCURRENCY);
  await Promise.all(runs.map((run) => limited(() => evaluateOne(run.id))));
  return summary;
}
