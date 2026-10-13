import {
  agentCriteria,
  agentMcpTools,
  agentRunCalls,
  agentRuns,
  agentSkills,
  agentSubAgents,
  agents,
  agentTools,
  agentVersions,
  db,
  getSettings,
  httpToolName,
  isUuid,
  mcpServers,
  mcpToolName,
  runEvaluations,
  skills,
  subAgentToolName,
  tools,
} from "@agentlathe/db";
import { and, asc, desc, eq, gte, lte, type SQL, sql } from "drizzle-orm";
import {
  assembleAgentEvaluation,
  assembleAgentUsage,
  assembleCapabilities,
  buildDailySeries,
  type CapabilityUsage,
  type ConfiguredCapability,
  reconcileParents,
  summarizeEvaluation,
  toDate,
} from "./metrics-assembly";
import { type MetricsRange, previousRangeStart } from "./metrics-range";

export const runDay = sql<string>`to_char(${agentRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;

const runAggregates = {
  runs: sql<number>`count(*)::int`,
  errors: sql<number>`(count(*) filter (where ${agentRuns.status} = 'error'))::int`,
  avgDurationMs: sql<number>`coalesce(avg(${agentRuns.durationMs}), 0)::int`,
  tokens: sql<number>`coalesce(sum(coalesce(${agentRuns.inputTokens}, 0) + coalesce(${agentRuns.outputTokens}, 0)), 0)::int`,
};

const p50 = sql<number>`coalesce(percentile_cont(0.5) within group (order by ${agentRuns.durationMs}), 0)::int`;
const p95 = sql<number>`coalesce(percentile_cont(0.95) within group (order by ${agentRuns.durationMs}), 0)::int`;

async function configuredCapabilities(): Promise<ConfiguredCapability[]> {
  const [toolRows, skillRows, mcpRows, subRows] = await Promise.all([
    db
      .select({ agentId: agentTools.agentId, name: tools.name })
      .from(agentTools)
      .innerJoin(tools, eq(agentTools.toolId, tools.id)),
    db
      .select({ agentId: agentSkills.agentId, name: skills.name })
      .from(agentSkills)
      .innerJoin(skills, eq(agentSkills.skillId, skills.id)),
    db
      .select({
        agentId: agentMcpTools.agentId,
        server: mcpServers.name,
        tool: agentMcpTools.toolName,
      })
      .from(agentMcpTools)
      .innerJoin(mcpServers, eq(agentMcpTools.serverId, mcpServers.id)),
    db
      .select({
        agentId: agentSubAgents.parentId,
        name: agents.name,
        slug: agents.slug,
      })
      .from(agentSubAgents)
      .innerJoin(agents, eq(agentSubAgents.childId, agents.id)),
  ]);

  return [
    ...toolRows.map((row) => ({
      agentId: row.agentId,
      kind: "tool",
      name: httpToolName(row.name),
      displayName: row.name,
    })),
    ...skillRows.map((row) => ({
      agentId: row.agentId,
      kind: "skill",
      name: row.name,
      displayName: row.name,
    })),
    ...mcpRows.map((row) => ({
      agentId: row.agentId,
      kind: "mcp",
      name: mcpToolName(row.server, row.tool),
      displayName: `${row.server}: ${row.tool}`,
    })),
    ...subRows.map((row) => ({
      agentId: row.agentId,
      kind: "sub_agent",
      name: subAgentToolName(row.slug),
      displayName: row.name,
    })),
  ];
}

const runTotalsSelect = (where: SQL | undefined) =>
  db
    .select({
      ...runAggregates,
      p50DurationMs: p50,
      p95DurationMs: p95,
      inputTokens: sql<number>`coalesce(sum(${agentRuns.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${agentRuns.outputTokens}), 0)::int`,
      approvalsRequested: sql<number>`coalesce(sum(${agentRuns.approvalsRequested}), 0)::int`,
      approvalsGranted: sql<number>`coalesce(sum(${agentRuns.approvalsGranted}), 0)::int`,
      toolCalls: sql<number>`coalesce(sum(${agentRuns.toolCalls}), 0)::int`,
    })
    .from(agentRuns)
    .where(where);

const dailyBySourceSelect = (where: SQL | undefined) =>
  db
    .select({
      day: runDay,
      source: agentRuns.source,
      runs: sql<number>`count(*)::int`,
      errors: sql<number>`(count(*) filter (where ${agentRuns.status} = 'error'))::int`,
      p50DurationMs: p50,
      p95DurationMs: p95,
      inputTokens: sql<number>`coalesce(sum(${agentRuns.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${agentRuns.outputTokens}), 0)::int`,
    })
    .from(agentRuns)
    .where(where)
    .groupBy(sql`1`, agentRuns.source)
    .orderBy(sql`1`);

const dailyLatencySelect = (where: SQL | undefined) =>
  db
    .select({
      day: runDay,
      p50DurationMs: p50,
      p95DurationMs: p95,
    })
    .from(agentRuns)
    .where(where)
    .groupBy(sql`1`)
    .orderBy(sql`1`);

const callStatsSelect = (where: SQL | undefined) =>
  db
    .select({
      kind: agentRunCalls.kind,
      name: agentRunCalls.name,
      calls: sql<number>`(count(*) filter (where ${agentRunCalls.status} <> 'denied'))::int`,
      errors: sql<number>`(count(*) filter (where ${agentRunCalls.status} = 'error'))::int`,
      denied: sql<number>`(count(*) filter (where ${agentRunCalls.status} = 'denied'))::int`,
      p95DurationMs: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${agentRunCalls.durationMs}), 0)::int`,
      sources: sql<
        string[]
      >`array_agg(distinct ${agentRuns.source} order by ${agentRuns.source})`,
    })
    .from(agentRunCalls)
    .innerJoin(agentRuns, eq(agentRunCalls.runId, agentRuns.id))
    .where(where)
    .groupBy(agentRunCalls.kind, agentRunCalls.name)
    .orderBy(desc(sql`count(*)`));

const runSpanSelect = (where: SQL | undefined) =>
  db
    .select({
      first: sql<
        string | null
      >`to_char(min(${agentRuns.createdAt}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      last: sql<
        string | null
      >`to_char(max(${agentRuns.createdAt}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    })
    .from(agentRuns)
    .where(where);

const judgedVerdict = sql`coalesce(${runEvaluations.reviewedVerdict}, ${runEvaluations.status})`;
const unreviewed = sql`${runEvaluations.status} = 'needs_review' and ${runEvaluations.reviewedVerdict} is null`;
const countWhere = (condition: SQL) =>
  sql<number>`(count(*) filter (where ${condition}))::int`;

const currentVerdicts = (runWhere: SQL | undefined) =>
  and(
    runWhere,
    eq(agentCriteria.isActive, true),
    eq(runEvaluations.questionSnapshot, agentCriteria.question),
  );

const evaluationAggregateSelect = (runWhere: SQL | undefined) =>
  db
    .select({
      criterionId: runEvaluations.criterionId,
      versionId: agentRuns.agentVersionId,
      day: runDay,
      pass: countWhere(sql`${judgedVerdict} = 'pass'`),
      fail: countWhere(sql`${judgedVerdict} = 'fail'`),
      needsReview: countWhere(unreviewed),
      judgedReviewed: countWhere(
        sql`${runEvaluations.reviewedVerdict} is not null and ${runEvaluations.status} in ('pass', 'fail')`,
      ),
      agreed: countWhere(
        sql`${runEvaluations.reviewedVerdict} is not null and ${runEvaluations.status} = ${runEvaluations.reviewedVerdict}`,
      ),
      reviewedAsPass: countWhere(
        sql`${runEvaluations.status} = 'needs_review' and ${runEvaluations.reviewedVerdict} = 'pass'`,
      ),
      reviewedAsFail: countWhere(
        sql`${runEvaluations.status} = 'needs_review' and ${runEvaluations.reviewedVerdict} = 'fail'`,
      ),
    })
    .from(runEvaluations)
    .innerJoin(agentRuns, eq(runEvaluations.runId, agentRuns.id))
    .innerJoin(agentCriteria, eq(runEvaluations.criterionId, agentCriteria.id))
    .where(currentVerdicts(runWhere))
    .groupBy(runEvaluations.criterionId, agentRuns.agentVersionId, sql`3`);

const evaluationByAgentSelect = (runWhere: SQL | undefined) =>
  db
    .select({
      agentId: agentRuns.agentId,
      pass: countWhere(sql`${judgedVerdict} = 'pass'`),
      fail: countWhere(sql`${judgedVerdict} = 'fail'`),
      needsReview: countWhere(unreviewed),
    })
    .from(runEvaluations)
    .innerJoin(agentRuns, eq(runEvaluations.runId, agentRuns.id))
    .innerJoin(agentCriteria, eq(runEvaluations.criterionId, agentCriteria.id))
    .where(currentVerdicts(runWhere))
    .groupBy(agentRuns.agentId);

const awaitingReviewRunsSelect = () =>
  db
    .select({
      runs: sql<number>`count(distinct ${runEvaluations.runId})::int`,
    })
    .from(runEvaluations)
    .innerJoin(agentCriteria, eq(runEvaluations.criterionId, agentCriteria.id))
    .where(currentVerdicts(unreviewed));

const agentVersionSpansSelect = (runWhere: SQL | undefined) =>
  db
    .select({
      id: agentVersions.id,
      hash: agentVersions.hash,
      createdAt: agentVersions.createdAt,
      snapshot: agentVersions.snapshot,
      firstRunAt: sql<string>`to_char(min(${agentRuns.createdAt}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      lastRunAt: sql<string>`to_char(max(${agentRuns.createdAt}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    })
    .from(agentRuns)
    .innerJoin(agentVersions, eq(agentRuns.agentVersionId, agentVersions.id))
    .where(runWhere)
    .groupBy(agentVersions.id, agentVersions.hash, agentVersions.createdAt);

export async function getMetricsData(range: MetricsRange) {
  const appSettings = await getSettings();
  const previousSince = previousRangeStart(range);
  const inWindow = and(
    gte(agentRuns.createdAt, range.since),
    lte(agentRuns.createdAt, range.until),
  );

  const [
    totals,
    byAgent,
    byTool,
    daily,
    dailyLatency,
    perAgentDaily,
    activeAgents,
    configured,
    used,
    span,
    evaluationRows,
    awaitingReview,
  ] = await Promise.all([
    runTotalsSelect(inWindow),

    db
      .select({
        agentId: agents.id,
        agentName: agents.name,
        model: agents.model,
        ...runAggregates,
        p50DurationMs: p50,
        p95DurationMs: p95,
        inputTokens: sql<number>`coalesce(sum(${agentRuns.inputTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${agentRuns.outputTokens}), 0)::int`,
      })
      .from(agentRuns)
      .innerJoin(agents, eq(agentRuns.agentId, agents.id))
      .where(inWindow)
      .groupBy(agents.id, agents.name, agents.model)
      .orderBy(desc(sql`count(*)`)),

    callStatsSelect(inWindow),

    dailyBySourceSelect(inWindow),

    dailyLatencySelect(inWindow),

    db
      .select({
        agentId: agentRuns.agentId,
        day: runDay,
        runs: sql<number>`count(*)::int`,
      })
      .from(agentRuns)
      .where(
        and(
          gte(agentRuns.createdAt, previousSince),
          lte(agentRuns.createdAt, range.until),
        ),
      )
      .groupBy(agentRuns.agentId, sql`2`),

    db
      .select({ id: agents.id, name: agents.name, model: agents.model })
      .from(agents)
      .where(eq(agents.isActive, true)),

    configuredCapabilities(),

    db
      .selectDistinct({
        agentId: agentRuns.agentId,
        kind: agentRunCalls.kind,
        name: agentRunCalls.name,
      })
      .from(agentRunCalls)
      .innerJoin(agentRuns, eq(agentRunCalls.runId, agentRuns.id))
      .where(inWindow),

    runSpanSelect(undefined),

    evaluationByAgentSelect(inWindow),

    awaitingReviewRunsSelect(),
  ]);

  const usage = assembleAgentUsage({
    byAgent,
    activeAgents,
    configured,
    used,
    perAgentDaily,
    days: range.days,
  });

  return {
    settings: appSettings,
    totals: totals[0],
    byAgent: usage.byAgent,
    neverRun: usage.neverRun,
    byTool,
    daily,
    dailyLatency,
    days: range.days,
    range,
    firstRunAt: toDate(span[0]?.first),
    lastRunAt: toDate(span[0]?.last),
    evaluation: {
      ...summarizeEvaluation(evaluationRows),
      awaitingReviewRuns: awaitingReview[0]?.runs ?? 0,
    },
  };
}

export async function getAgentMetricsData(
  agentId: string,
  range: MetricsRange,
) {
  if (!isUuid(agentId)) return null;

  const [agent] = await db
    .select({
      id: agents.id,
      name: agents.name,
      slug: agents.slug,
      model: agents.model,
      description: agents.description,
      isActive: agents.isActive,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agent) return null;

  const previousSince = previousRangeStart(range);
  const ofAgent = eq(agentRuns.agentId, agentId);
  const inWindow = and(
    ofAgent,
    gte(agentRuns.createdAt, range.since),
    lte(agentRuns.createdAt, range.until),
  );
  const delegationName = subAgentToolName(agent.slug);

  const [
    appSettings,
    totals,
    daily,
    dailyLatency,
    bySource,
    callStats,
    configured,
    parentLinks,
    parentCalls,
    recentErrors,
    perDay,
    span,
    criteria,
    evaluationRows,
    versionSpans,
  ] = await Promise.all([
    getSettings(),

    runTotalsSelect(inWindow),

    dailyBySourceSelect(inWindow),

    dailyLatencySelect(inWindow),

    db
      .select({
        source: agentRuns.source,
        ...runAggregates,
        p95DurationMs: p95,
      })
      .from(agentRuns)
      .where(inWindow)
      .groupBy(agentRuns.source)
      .orderBy(desc(sql`count(*)`)),

    callStatsSelect(inWindow),

    configuredCapabilities(),

    db
      .select({ id: agents.id, name: agents.name })
      .from(agentSubAgents)
      .innerJoin(agents, eq(agentSubAgents.parentId, agents.id))
      .where(eq(agentSubAgents.childId, agentId)),

    db
      .select({
        parentId: agentRuns.agentId,
        parentName: agents.name,
        calls: sql<number>`count(*)::int`,
      })
      .from(agentRunCalls)
      .innerJoin(agentRuns, eq(agentRunCalls.runId, agentRuns.id))
      .innerJoin(agents, eq(agentRuns.agentId, agents.id))
      .where(
        and(
          gte(agentRuns.createdAt, range.since),
          lte(agentRuns.createdAt, range.until),
          eq(agentRunCalls.kind, "sub_agent"),
          eq(agentRunCalls.name, delegationName),
        ),
      )
      .groupBy(agentRuns.agentId, agents.name),

    db
      .select({
        id: agentRuns.id,
        createdAt: agentRuns.createdAt,
        source: agentRuns.source,
        error: agentRuns.error,
      })
      .from(agentRuns)
      .where(and(inWindow, eq(agentRuns.status, "error")))
      .orderBy(desc(agentRuns.createdAt))
      .limit(8),

    db
      .select({ day: runDay, runs: sql<number>`count(*)::int` })
      .from(agentRuns)
      .where(
        and(
          ofAgent,
          gte(agentRuns.createdAt, previousSince),
          lte(agentRuns.createdAt, range.until),
        ),
      )
      .groupBy(sql`1`),

    runSpanSelect(ofAgent),

    db
      .select({
        id: agentCriteria.id,
        question: agentCriteria.question,
        isActive: agentCriteria.isActive,
      })
      .from(agentCriteria)
      .where(eq(agentCriteria.agentId, agentId))
      .orderBy(asc(agentCriteria.createdAt)),

    evaluationAggregateSelect(inWindow),

    agentVersionSpansSelect(inWindow),
  ]);

  const capabilities: CapabilityUsage[] = assembleCapabilities(
    configured.filter((row) => row.agentId === agentId),
    callStats,
  );
  const { series, previousRuns, activeDays } = buildDailySeries(
    perDay,
    range.days,
  );
  const parents = reconcileParents(parentLinks, parentCalls);
  const evaluation = assembleAgentEvaluation({
    criteria,
    rows: evaluationRows,
    versions: versionSpans.flatMap((row) => {
      const firstRunAt = toDate(row.firstRunAt);
      const lastRunAt = toDate(row.lastRunAt);
      return firstRunAt && lastRunAt ? [{ ...row, firstRunAt, lastRunAt }] : [];
    }),
    days: range.days,
  });

  return {
    agent,
    settings: appSettings,
    totals: totals[0],
    daily,
    dailyLatency,
    bySource,
    capabilities,
    parents,
    evaluation,
    recentErrors,
    series,
    previousRuns,
    activeDays,
    days: range.days,
    range,
    firstRunAt: toDate(span[0]?.first),
    lastRunAt: toDate(span[0]?.last),
  };
}
