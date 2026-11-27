import {
  type EvaluationFilter,
  parseEvaluationFilter,
} from "./run-evaluation-filter";
import { SOURCE_ORDER } from "./run-sources";

export type RunsFilter = {
  q: string;
  source: string;
  subject: string;
  evaluation: EvaluationFilter | "";
  agent: string;
  attention: boolean;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseRunsFilter(
  params: Partial<Record<keyof RunsFilter, string>>,
): RunsFilter {
  const agent = (params.agent ?? "").trim();
  return {
    q: (params.q ?? "").trim(),
    source: SOURCE_ORDER.some((value) => value === params.source)
      ? (params.source as string)
      : "",
    subject: (params.subject ?? "").trim(),
    evaluation: parseEvaluationFilter(params.evaluation),
    agent: UUID_RE.test(agent) ? agent : "",
    attention: params.attention === "1",
  };
}

export function runsFilterQuery(filter: RunsFilter, page = 1): string {
  const params = new URLSearchParams();
  if (filter.q) params.set("q", filter.q);
  if (filter.source) params.set("source", filter.source);
  if (filter.subject) params.set("subject", filter.subject);
  if (filter.evaluation) params.set("evaluation", filter.evaluation);
  if (filter.agent) params.set("agent", filter.agent);
  if (filter.attention) params.set("attention", "1");
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function hasRunsFilter(filter: RunsFilter): boolean {
  return runsFilterQuery(filter) !== "";
}
