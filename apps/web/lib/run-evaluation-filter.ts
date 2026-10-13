export const EVALUATION_FILTERS = [
  "needs_review",
  "failed",
  "not_evaluated",
] as const;

export type EvaluationFilter = (typeof EVALUATION_FILTERS)[number];

export const EVALUATION_FILTER_LABEL: Record<EvaluationFilter, string> = {
  needs_review: "Needs review",
  failed: "Failed",
  not_evaluated: "Not evaluated",
};

export function parseEvaluationFilter(
  value: string | undefined,
): EvaluationFilter | "" {
  return EVALUATION_FILTERS.find((filter) => filter === value) ?? "";
}
