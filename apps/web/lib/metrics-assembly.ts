import type {
  LatencyPoint,
  RunPoint,
  TokenPoint,
} from "@/components/metrics-charts";

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
