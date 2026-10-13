import type {
  LatencyPoint,
  PassRatePoint,
  PassRateSeries,
  RunPoint,
  TokenPoint,
  VersionMarker,
} from "@/components/metrics-charts";
import { diffVersions, type VersionChanges } from "./version-diff";

export type ConfiguredCapability = {
  agentId: string;
  kind: string;
  name: string;
  displayName: string;
};

export type CapabilityCallStats = {
  kind: string;
  name: string;
  calls: number;
  errors: number;
  denied: number;
  p95DurationMs: number;
};

export type CapabilityUsage = CapabilityCallStats & {
  displayName: string;
  configured: boolean;
};

export function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

type DailyRow = {
  day: string;
  source: string;
  runs: number;
  errors: number;
  p50DurationMs: number;
  p95DurationMs: number;
  inputTokens: number;
  outputTokens: number;
};

type DailyLatencyRow = {
  day: string;
  p50DurationMs: number;
  p95DurationMs: number;
};

export function buildChartPoints(
  daily: DailyRow[],
  dailyLatency: DailyLatencyRow[],
  days: string[],
): {
  runPoints: RunPoint[];
  latencyPoints: LatencyPoint[];
  tokenPoints: TokenPoint[];
  sources: string[];
} {
  const sources = [...new Set(daily.map((row) => row.source))];

  const runPoints: RunPoint[] = days.map((day) => {
    const point: RunPoint = { day, total: 0, errors: 0 };
    for (const source of sources) point[source] = 0;
    for (const row of daily.filter((entry) => entry.day === day)) {
      point[row.source] = row.runs;
      point.total += row.runs;
      point.errors += row.errors;
    }
    return point;
  });

  const latencyByDay = new Map(dailyLatency.map((row) => [row.day, row]));
  const latencyPoints: LatencyPoint[] = days.map((day) => {
    const row = latencyByDay.get(day);
    return {
      day,
      p50: row?.p50DurationMs ?? 0,
      p95: row?.p95DurationMs ?? 0,
    };
  });

  const tokenPoints: TokenPoint[] = days.map((day) => {
    const rows = daily.filter((row) => row.day === day);
    const input = rows.reduce((total, row) => total + row.inputTokens, 0);
    const output = rows.reduce((total, row) => total + row.outputTokens, 0);
    return { day, input, output, total: input + output };
  });

  return { runPoints, latencyPoints, tokenPoints, sources };
}

const key = (kind: string, name: string) => `${kind}:${name}`;
const agentKey = (agentId: string, kind: string, name: string) =>
  `${agentId}:${kind}:${name}`;

function summarizeConfiguredUsage(
  configured: ConfiguredCapability[],
  used: Array<{ agentId: string; kind: string; name: string }>,
): {
  configuredCount: Map<string, number>;
  unusedByAgent: Map<
    string,
    Array<{ kind: string; name: string; displayName: string }>
  >;
} {
  const usedKeys = new Set(
    used.map((row) => agentKey(row.agentId, row.kind, row.name)),
  );
  const configuredCount = new Map<string, number>();
  const unusedByAgent = new Map<
    string,
    Array<{ kind: string; name: string; displayName: string }>
  >();
  for (const row of configured) {
    configuredCount.set(
      row.agentId,
      (configuredCount.get(row.agentId) ?? 0) + 1,
    );
    if (usedKeys.has(agentKey(row.agentId, row.kind, row.name))) continue;
    const list = unusedByAgent.get(row.agentId) ?? [];
    list.push({ kind: row.kind, name: row.name, displayName: row.displayName });
    unusedByAgent.set(row.agentId, list);
  }
  return { configuredCount, unusedByAgent };
}

export function assembleAgentUsage<
  Row extends { agentId: string; runs: number },
>(input: {
  byAgent: Row[];
  activeAgents: Array<{ id: string; name: string; model: string }>;
  configured: ConfiguredCapability[];
  used: Array<{ agentId: string; kind: string; name: string }>;
  perAgentDaily: Array<{ agentId: string; day: string; runs: number }>;
  days: string[];
}) {
  const { byAgent, activeAgents, configured, used, perAgentDaily, days } =
    input;
  const { configuredCount, unusedByAgent } = summarizeConfiguredUsage(
    configured,
    used,
  );

  const firstDay = days[0];
  const runsByAgentDay = new Map(
    perAgentDaily.map((row) => [`${row.agentId}:${row.day}`, row.runs]),
  );
  const previousRunsByAgent = new Map<string, number>();
  for (const row of perAgentDaily) {
    if (row.day >= firstDay) continue;
    previousRunsByAgent.set(
      row.agentId,
      (previousRunsByAgent.get(row.agentId) ?? 0) + row.runs,
    );
  }

  const withUsage = byAgent.map((row) => ({
    ...row,
    configured: configuredCount.get(row.agentId) ?? 0,
    unused: unusedByAgent.get(row.agentId) ?? [],
    series: days.map((day) => runsByAgentDay.get(`${row.agentId}:${day}`) ?? 0),
    activeDays: days.filter((day) =>
      runsByAgentDay.has(`${row.agentId}:${day}`),
    ).length,
    recentRuns: row.runs,
    previousRuns: previousRunsByAgent.get(row.agentId) ?? 0,
  }));

  const withRuns = new Set(byAgent.map((row) => row.agentId));
  const neverRun = activeAgents.filter((agent) => !withRuns.has(agent.id));

  return { byAgent: withUsage, neverRun };
}

export function assembleCapabilities(
  configured: Array<Omit<ConfiguredCapability, "agentId">>,
  callStats: CapabilityCallStats[],
): CapabilityUsage[] {
  const statsByKey = new Map(
    callStats.map((row) => [key(row.kind, row.name), row]),
  );
  const capabilities: CapabilityUsage[] = configured.map((row) => {
    const stats = statsByKey.get(key(row.kind, row.name));
    statsByKey.delete(key(row.kind, row.name));
    return {
      kind: row.kind,
      name: row.name,
      displayName: row.displayName,
      configured: true,
      calls: stats?.calls ?? 0,
      errors: stats?.errors ?? 0,
      denied: stats?.denied ?? 0,
      p95DurationMs: stats?.p95DurationMs ?? 0,
    };
  });
  for (const stats of statsByKey.values()) {
    capabilities.push({ ...stats, displayName: stats.name, configured: false });
  }
  capabilities.sort(
    (a, b) =>
      b.calls + b.denied - (a.calls + a.denied) ||
      a.displayName.localeCompare(b.displayName),
  );
  return capabilities;
}

export function buildDailySeries(
  perDay: Array<{ day: string; runs: number }>,
  days: string[],
): { series: number[]; previousRuns: number; activeDays: number } {
  const runsByDay = new Map(perDay.map((row) => [row.day, row.runs]));
  const firstDay = days[0];
  const series = days.map((day) => runsByDay.get(day) ?? 0);
  const previousRuns = perDay
    .filter((row) => row.day < firstDay)
    .reduce((total, row) => total + row.runs, 0);
  return {
    series,
    previousRuns,
    activeDays: series.filter((runs) => runs > 0).length,
  };
}

export function reconcileParents(
  parentLinks: Array<{ id: string; name: string }>,
  parentCalls: Array<{ parentId: string; parentName: string; calls: number }>,
): Array<{ id: string; name: string; calls: number }> {
  const callsByParent = new Map(
    parentCalls.map((row) => [row.parentId, row.calls]),
  );
  const parents = parentLinks.map((parent) => ({
    ...parent,
    calls: callsByParent.get(parent.id) ?? 0,
  }));
  for (const row of parentCalls) {
    if (parentLinks.some((parent) => parent.id === row.parentId)) continue;
    parents.push({ id: row.parentId, name: row.parentName, calls: row.calls });
  }
  parents.sort((a, b) => b.calls - a.calls);
  return parents;
}

export const MIN_EVALUATION_SAMPLE = 5;

export type EvaluationCounts = {
  pass: number;
  fail: number;
  needsReview: number;
};

export type EvaluationAggregateRow = EvaluationCounts & {
  criterionId: string;
  versionId: string | null;
  day: string;
  agreed: number;
  judgedReviewed: number;
  reviewedAsPass: number;
  reviewedAsFail: number;
};

export type EvaluationVersionSpan = {
  id: string;
  hash: string;
  createdAt: Date;
  firstRunAt: Date;
  lastRunAt: Date;
  snapshot: unknown;
};

export type EvaluationCriterion = {
  id: string;
  question: string;
  isActive: boolean;
};

export type EvaluationStat = {
  judged: number;
  needsReview: number;
  passRate: number | null;
};

export type EvaluationVersionColumn = {
  id: string;
  shortHash: string;
  createdAt: Date;
  lastRunAt: Date;
  newest: boolean;
  changes: { previousShortHash: string; diff: VersionChanges } | null;
};

export type EvaluationVersionDelta =
  | { kind: "none" }
  | { kind: "small_sample" }
  | { kind: "points"; points: number };

export type EvaluationCriterionRow = {
  id: string;
  question: string;
  total: EvaluationStat;
  cells: EvaluationStat[];
  delta: EvaluationVersionDelta;
};

export type EvaluationAgreement = {
  judgedReviewed: number;
  agreed: number;
  agreementRate: number | null;
  enough: boolean;
  resolvedAsPass: number;
  resolvedAsFail: number;
};

export type AgentEvaluation = {
  hasVerdicts: boolean;
  activeCriteria: number;
  inactiveCriteria: number;
  versions: EvaluationVersionColumn[];
  rows: EvaluationCriterionRow[];
  series: PassRateSeries[];
  points: PassRatePoint[];
  markers: VersionMarker[];
  agreement: EvaluationAgreement;
};

export function passRate(counts: { pass: number; fail: number }) {
  const judged = counts.pass + counts.fail;
  return judged > 0 ? counts.pass / judged : null;
}

function toStat(counts: EvaluationCounts): EvaluationStat {
  return {
    judged: counts.pass + counts.fail,
    needsReview: counts.needsReview,
    passRate: passRate(counts),
  };
}

const emptyCounts = (): EvaluationCounts => ({
  pass: 0,
  fail: 0,
  needsReview: 0,
});

function addCounts(target: EvaluationCounts, row: EvaluationCounts) {
  target.pass += row.pass;
  target.fail += row.fail;
  target.needsReview += row.needsReview;
}

const hasVerdicts = (row: EvaluationCounts) =>
  row.pass + row.fail + row.needsReview > 0;

function versionDelta(
  previous: EvaluationStat | undefined,
  newest: EvaluationStat | undefined,
): EvaluationVersionDelta {
  if (
    !previous ||
    !newest ||
    previous.passRate === null ||
    newest.passRate === null
  )
    return { kind: "none" };
  if (
    previous.judged < MIN_EVALUATION_SAMPLE ||
    newest.judged < MIN_EVALUATION_SAMPLE
  )
    return { kind: "small_sample" };
  return {
    kind: "points",
    points:
      Math.round(newest.passRate * 100) - Math.round(previous.passRate * 100),
  };
}

export function assembleAgentEvaluation(input: {
  criteria: EvaluationCriterion[];
  rows: EvaluationAggregateRow[];
  versions: EvaluationVersionSpan[];
  days: string[];
}): AgentEvaluation {
  const { rows, days } = input;
  const active = input.criteria.filter((criterion) => criterion.isActive);
  const activeIds = new Set(active.map((criterion) => criterion.id));
  const scoped = rows.filter((row) => activeIds.has(row.criterionId));

  const orderedVersions = [...input.versions].sort(
    (a, b) =>
      a.lastRunAt.getTime() - b.lastRunAt.getTime() ||
      a.firstRunAt.getTime() - b.firstRunAt.getTime(),
  );
  const judgedVersionIds = new Set(
    scoped
      .filter((row) => row.versionId !== null && hasVerdicts(row))
      .map((row) => row.versionId),
  );
  const judgedVersions = orderedVersions.filter((version) =>
    judgedVersionIds.has(version.id),
  );
  const versions: EvaluationVersionColumn[] = judgedVersions.map(
    (version, index) => {
      const previous = judgedVersions[index - 1];
      return {
        id: version.id,
        shortHash: version.hash.slice(0, 8),
        createdAt: version.createdAt,
        lastRunAt: version.lastRunAt,
        newest: index === judgedVersions.length - 1,
        changes: previous
          ? {
              previousShortHash: previous.hash.slice(0, 8),
              diff: diffVersions(previous.snapshot, version.snapshot),
            }
          : null,
      };
    },
  );

  const cellCounts = new Map<string, EvaluationCounts>();
  const totalCounts = new Map<string, EvaluationCounts>();
  const dayCounts = new Map<string, EvaluationCounts>();
  const agreement = {
    judgedReviewed: 0,
    agreed: 0,
    resolvedAsPass: 0,
    resolvedAsFail: 0,
  };
  for (const row of scoped) {
    const total = totalCounts.get(row.criterionId) ?? emptyCounts();
    addCounts(total, row);
    totalCounts.set(row.criterionId, total);

    const dayKey = `${row.criterionId}:${row.day}`;
    const perDay = dayCounts.get(dayKey) ?? emptyCounts();
    addCounts(perDay, row);
    dayCounts.set(dayKey, perDay);

    if (row.versionId !== null) {
      const cellKey = `${row.criterionId}:${row.versionId}`;
      const cell = cellCounts.get(cellKey) ?? emptyCounts();
      addCounts(cell, row);
      cellCounts.set(cellKey, cell);
    }

    agreement.judgedReviewed += row.judgedReviewed;
    agreement.agreed += row.agreed;
    agreement.resolvedAsPass += row.reviewedAsPass;
    agreement.resolvedAsFail += row.reviewedAsFail;
  }

  const criterionRows: EvaluationCriterionRow[] = active.map((criterion) => {
    const cells = versions.map((version) =>
      toStat(cellCounts.get(`${criterion.id}:${version.id}`) ?? emptyCounts()),
    );
    return {
      id: criterion.id,
      question: criterion.question,
      total: toStat(totalCounts.get(criterion.id) ?? emptyCounts()),
      cells,
      delta:
        cells.length >= 2
          ? versionDelta(cells.at(-2), cells.at(-1))
          : { kind: "none" },
    };
  });

  const series: PassRateSeries[] = active.map((criterion, index) => ({
    key: `c${index}`,
    criterionId: criterion.id,
    question: criterion.question,
  }));
  const points: PassRatePoint[] = days.map((day) => {
    const point: PassRatePoint = { day };
    for (const entry of series) {
      const counts = dayCounts.get(`${entry.criterionId}:${day}`);
      const rate = counts ? passRate(counts) : null;
      point[entry.key] = rate === null ? null : Math.round(rate * 100);
      point[`${entry.key}_n`] = counts ? counts.pass + counts.fail : 0;
    }
    return point;
  });

  const daySet = new Set(days);
  const markerByDay = new Map<string, string[]>();
  if (input.versions.length > 1) {
    const byFirstRun = [...input.versions].sort(
      (a, b) => a.firstRunAt.getTime() - b.firstRunAt.getTime(),
    );
    for (const version of byFirstRun) {
      const day = version.firstRunAt.toISOString().slice(0, 10);
      if (!daySet.has(day)) continue;
      markerByDay.set(day, [
        ...(markerByDay.get(day) ?? []),
        version.hash.slice(0, 8),
      ]);
    }
  }
  const markers: VersionMarker[] = [...markerByDay.entries()].map(
    ([day, hashes]) => ({ day, shortHash: hashes.join(" · ") }),
  );

  return {
    hasVerdicts: scoped.some(hasVerdicts),
    activeCriteria: active.length,
    inactiveCriteria: input.criteria.length - active.length,
    versions,
    rows: criterionRows,
    series,
    points,
    markers,
    agreement: {
      ...agreement,
      agreementRate:
        agreement.judgedReviewed > 0
          ? agreement.agreed / agreement.judgedReviewed
          : null,
      enough: agreement.judgedReviewed >= MIN_EVALUATION_SAMPLE,
    },
  };
}

export type AgentEvaluationCounts = EvaluationCounts & { agentId: string };

export type EvaluationSummary = EvaluationCounts & { passRate: number | null };

export function summarizeEvaluation(rows: AgentEvaluationCounts[]): {
  overall: EvaluationSummary;
  byAgent: Record<string, EvaluationSummary>;
} {
  const overall = emptyCounts();
  const byAgent: Record<string, EvaluationCounts> = {};
  for (const row of rows) {
    addCounts(overall, row);
    byAgent[row.agentId] ??= emptyCounts();
    addCounts(byAgent[row.agentId], row);
  }
  return {
    overall: { ...overall, passRate: passRate(overall) },
    byAgent: Object.fromEntries(
      Object.entries(byAgent).map(([agentId, counts]) => [
        agentId,
        { ...counts, passRate: passRate(counts) },
      ]),
    ),
  };
}
