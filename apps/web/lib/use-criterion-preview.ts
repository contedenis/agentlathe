"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/mutate";

export const PREVIEW_DEBOUNCE_MS = 800;

export type PreviewDraft = {
  question: string;
  passDescription: string | null;
  failDescription: string | null;
  appliesWhen: string | null;
  failBelow: number;
  passAbove: number;
};

export type PreviewResponse =
  | { skipped: "no_transcript" }
  | {
      status:
        | "pass"
        | "fail"
        | "needs_review"
        | "not_applicable"
        | "skipped"
        | "error";
      pPass: number | null;
      pApplies: number | null;
      skipReason: "too_long" | "awaiting_approval" | null;
      error: string | null;
    };

export type PreviewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; result: PreviewResponse }
  | { kind: "failed"; message: string };

export type PreviewNote = {
  tone: "good" | "warning" | "neutral" | "muted";
  text: string;
};

const PREFIX = "On the run this came from:";

function score(value: number | null): string {
  return value === null ? "no score" : value.toFixed(2);
}

export function describePreview(result: PreviewResponse): PreviewNote {
  if ("skipped" in result)
    return {
      tone: "muted",
      text: "This run has no stored transcript, so it can't be checked.",
    };
  switch (result.status) {
    case "fail":
      return {
        tone: "good",
        text: `${PREFIX} fails (${score(result.pPass)}) — as expected.`,
      };
    case "pass":
      return {
        tone: "warning",
        text: `${PREFIX} passes (${score(result.pPass)}). The draft describes a failure, so the question may be phrased the wrong way round.`,
      };
    case "needs_review":
      return {
        tone: "neutral",
        text: `${PREFIX} the judge is unsure (${score(result.pPass)}), so it would be flagged for review.`,
      };
    case "not_applicable":
      return {
        tone: "neutral",
        text: `${PREFIX} the condition does not hold (${score(result.pApplies)}), so the criterion would not apply.`,
      };
    case "skipped":
      return {
        tone: "muted",
        text:
          result.skipReason === "awaiting_approval"
            ? "That run was waiting for a tool approval, so it can't be judged."
            : "That run is too long for the judge to check.",
      };
    case "error":
      return {
        tone: "muted",
        text: `The check failed: ${result.error ?? "unknown error"}`,
      };
  }
}

export function useCriterionPreview(runId: string | null) {
  const [state, setState] = useState<PreviewState>({ kind: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    controller.current?.abort();
    controller.current = null;
    generation.current += 1;
  }, []);

  const schedule = useCallback(
    (draft: PreviewDraft | null) => {
      cancel();
      if (!runId || !draft) {
        setState({ kind: "idle" });
        return;
      }
      setState({ kind: "loading" });
      const mine = generation.current;
      timer.current = setTimeout(async () => {
        const abort = new AbortController();
        controller.current = abort;
        try {
          const result = await apiRequest<PreviewResponse>(
            `/api/runs/${runId}/evaluate/preview`,
            {
              method: "POST",
              body: JSON.stringify(draft),
              signal: abort.signal,
            },
          );
          if (generation.current === mine) setState({ kind: "done", result });
        } catch (err) {
          if (generation.current !== mine) return;
          setState({
            kind: "failed",
            message: err instanceof Error ? err.message : "Unknown error.",
          });
        }
      }, PREVIEW_DEBOUNCE_MS);
    },
    [runId, cancel],
  );

  useEffect(() => cancel, [cancel]);

  return { state, schedule };
}
