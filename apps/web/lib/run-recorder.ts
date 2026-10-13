import {
  type AgentRow,
  createRunRecorder,
  type RunRecorder,
  type RunRecorderOptions,
} from "@agentlathe/runner";
import { after } from "next/server";
import { evaluateRun, hasActiveCriteria } from "./evaluations";
import { createLimiter } from "./limiter";

const backgroundLimit = createLimiter(3);

export function scheduleRunEvaluation(
  runId: string,
  agent: Pick<AgentRow, "id" | "autoEvaluate">,
): void {
  if (!agent.autoEvaluate) return;
  const evaluation = Promise.resolve()
    .then(() => hasActiveCriteria(agent.id))
    .then((active) =>
      active ? backgroundLimit(() => evaluateRun(runId)) : undefined,
    )
    .then(
      () => {},
      (err) => console.error("automatic evaluation failed", err),
    );
  // A promise, not a callback: after(fn) waits for the response's close event, which a
  // streamed transport may already have emitted, and then never runs fn.
  try {
    after(evaluation);
  } catch {}
}

export function createRecorder(
  options: Omit<RunRecorderOptions, "onTranscriptSaved">,
): RunRecorder {
  return createRunRecorder({
    ...options,
    onTranscriptSaved: (runId) => scheduleRunEvaluation(runId, options.agent),
  });
}
