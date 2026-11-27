import {
  agentCriteria,
  agentRuns,
  db,
  fixDrafts,
  runEvaluations,
  runTranscripts,
} from "@agentlathe/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { isUuid } from "@/lib/api-helpers";
import { evaluationInput } from "@/lib/evaluation-input";

const REVIEW_ROWS = 30;
const FAILED_RUNS = 10;
const TRANSCRIPT_CHARS = 20_000;
const TRANSCRIPT_HEAD_CHARS = 5_000;

export type AgentReview = Awaited<ReturnType<typeof loadAgentReview>>;

export async function loadAgentReview(agentId: string) {
  const verdict = sql<string>`coalesce(${runEvaluations.reviewedVerdict}, ${runEvaluations.status})`;
  const [notes, verdicts, failedRuns] = await Promise.all([
    db
      .select({
        id: fixDrafts.id,
        runId: fixDrafts.runId,
        category: fixDrafts.category,
        rationale: fixDrafts.rationale,
        proposedValue: fixDrafts.proposedValue,
      })
      .from(fixDrafts)
      .innerJoin(agentRuns, eq(fixDrafts.runId, agentRuns.id))
      .where(and(eq(agentRuns.agentId, agentId), eq(fixDrafts.status, "open")))
      .orderBy(desc(fixDrafts.createdAt))
      .limit(REVIEW_ROWS),
    db
      .select({
        runId: runEvaluations.runId,
        question: agentCriteria.question,
        verdict,
      })
      .from(runEvaluations)
      .innerJoin(
        agentCriteria,
        eq(runEvaluations.criterionId, agentCriteria.id),
      )
      .where(
        and(
          eq(agentCriteria.agentId, agentId),
          eq(agentCriteria.isActive, true),
          eq(runEvaluations.questionSnapshot, agentCriteria.question),
          inArray(verdict, ["fail", "needs_review"]),
        ),
      )
      .orderBy(desc(runEvaluations.createdAt))
      .limit(REVIEW_ROWS),
    db
      .select({ runId: agentRuns.id, error: agentRuns.error })
      .from(agentRuns)
      .where(and(eq(agentRuns.agentId, agentId), eq(agentRuns.status, "error")))
      .orderBy(desc(agentRuns.createdAt))
      .limit(FAILED_RUNS),
  ]);
  return { notes, verdicts, failedRuns };
}

export async function loadRunTranscript(
  agentId: string,
  runId: string,
): Promise<string> {
  if (!isUuid(runId))
    throw new Error("runId must be a run id from get_agent_review.");
  const [row] = await db
    .select({ input: runTranscripts.input, output: runTranscripts.output })
    .from(runTranscripts)
    .innerJoin(agentRuns, eq(runTranscripts.runId, agentRuns.id))
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.agentId, agentId)))
    .limit(1);
  if (!row) throw new Error("That run of this agent has no stored transcript.");
  const rendered = evaluationInput(row.input, row.output);
  if ("awaitingApproval" in rendered)
    return "The run stopped waiting for a tool approval.";
  const text = rendered.state;
  if (text.length <= TRANSCRIPT_CHARS) return text;
  return `${text.slice(0, TRANSCRIPT_HEAD_CHARS)}\n…[middle of the run omitted]…\n${text.slice(TRANSCRIPT_HEAD_CHARS - TRANSCRIPT_CHARS)}`;
}
