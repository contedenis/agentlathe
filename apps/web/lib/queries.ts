import {
  agentMcpTools,
  agentRuns,
  agentSkills,
  agentSubAgents,
  agents,
  agentTools,
  db,
  fixDrafts,
  isUuid,
  mcpServers,
  runTranscripts,
  SECRET_ENV_PREFIX,
  skills,
  tools,
} from "@agentlathe/db";
import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import { runDay } from "./queries-metrics";

export function listAgents() {
  return db.select().from(agents).orderBy(desc(agents.createdAt));
}

export function listActiveAgentOptions() {
  return db
    .select({ id: agents.id, name: agents.name, slug: agents.slug })
    .from(agents)
    .where(eq(agents.isActive, true))
    .orderBy(agents.name);
}

export function listTools() {
  return db.select().from(tools).orderBy(desc(tools.createdAt));
}

export function listSkills() {
  return db.select().from(skills).orderBy(desc(skills.createdAt));
}

const mcpServerSafeColumns = {
  id: mcpServers.id,
  name: mcpServers.name,
  serverUrl: mcpServers.serverUrl,
  isActive: mcpServers.isActive,
  createdAt: mcpServers.createdAt,
  updatedAt: mcpServers.updatedAt,
  hasAuth: sql<boolean>`${mcpServers.authConfig} is not null`,
};

// Selected only to feed redactMcpServer — never returned to a client as-is.
export const mcpServerReturningColumns = {
  ...mcpServerSafeColumns,
  authConfig: mcpServers.authConfig,
};

function mcpServerAuthRefs(authConfig: unknown): Record<string, string> | null {
  if (!authConfig || typeof authConfig !== "object") return null;
  const headers = (authConfig as { headers?: unknown }).headers;
  if (!headers || typeof headers !== "object") return null;
  const refs = Object.entries(headers as Record<string, unknown>).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[1].startsWith(SECRET_ENV_PREFIX),
  );
  return refs.length > 0 ? Object.fromEntries(refs) : null;
}

// References are env var names, not secrets: they survive redaction. Literals never leave.
export function redactMcpServer<T extends { authConfig: unknown }>(row: T) {
  const { authConfig, ...safe } = row;
  return { ...safe, authRefs: mcpServerAuthRefs(authConfig) };
}

export async function listMcpServers() {
  const rows = await db
    .select(mcpServerReturningColumns)
    .from(mcpServers)
    .orderBy(desc(mcpServers.createdAt));
  return rows.map(redactMcpServer);
}

export async function getMcpServer(id: string) {
  const [row] = await db
    .select(mcpServerReturningColumns)
    .from(mcpServers)
    .where(eq(mcpServers.id, id))
    .limit(1);
  return row ? redactMcpServer(row) : undefined;
}

const openDraftCount = sql<number>`(
  select count(*) from ${fixDrafts}
  where ${fixDrafts.runId} = ${agentRuns.id} and ${fixDrafts.status} = 'open'
)::int`;

export async function listRunsPage({
  q,
  source,
  limit,
  offset,
}: {
  q: string;
  source?: string;
  limit: number;
  offset: number;
}) {
  const query = q.slice(0, 100);
  const escaped = query.replace(/[\\%_]/g, "\\$&");
  const filter = and(
    query ? ilike(agents.name, `%${escaped}%`) : undefined,
    source ? eq(agentRuns.source, source) : undefined,
  );

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: agentRuns.id,
        source: agentRuns.source,
        status: agentRuns.status,
        durationMs: agentRuns.durationMs,
        createdAt: agentRuns.createdAt,
        agentId: agents.id,
        agentName: agents.name,
        openDrafts: openDraftCount,
      })
      .from(agentRuns)
      .innerJoin(agents, eq(agentRuns.agentId, agents.id))
      .where(filter)
      .orderBy(desc(agentRuns.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ value: count() })
      .from(agentRuns)
      .innerJoin(agents, eq(agentRuns.agentId, agents.id))
      .where(filter),
  ]);

  return { rows, total: totals[0]?.value ?? 0 };
}

export async function getRunForReview(id: string) {
  if (!isUuid(id)) return undefined;
  const [row] = await db
    .select({
      id: agentRuns.id,
      source: agentRuns.source,
      status: agentRuns.status,
      model: agentRuns.model,
      threadId: agentRuns.threadId,
      durationMs: agentRuns.durationMs,
      steps: agentRuns.steps,
      toolCalls: agentRuns.toolCalls,
      inputTokens: agentRuns.inputTokens,
      outputTokens: agentRuns.outputTokens,
      mcpFailures: agentRuns.mcpFailures,
      error: agentRuns.error,
      createdAt: agentRuns.createdAt,
      agentId: agents.id,
      agentName: agents.name,
      input: runTranscripts.input,
      output: runTranscripts.output,
    })
    .from(agentRuns)
    .innerJoin(agents, eq(agentRuns.agentId, agents.id))
    .leftJoin(runTranscripts, eq(runTranscripts.runId, agentRuns.id))
    .where(eq(agentRuns.id, id))
    .limit(1);
  if (!row) return undefined;

  const drafts = await db
    .select()
    .from(fixDrafts)
    .where(eq(fixDrafts.runId, id))
    .orderBy(fixDrafts.createdAt);

  return { ...row, drafts };
}

type Warning = {
  type: "skill" | "tool" | "mcp_server" | "sub_agent";
  id: string;
  name: string;
};

type McpRefGroup = {
  serverId: string;
  serverName: string;
  status: "ok" | "inactive";
  tools: Array<{ name: string; needsApproval: boolean }>;
};

export async function getAgentDetail(id: string) {
  if (!isUuid(id)) return null;
  const [agentRow, skillRows, toolRows, mcpRows, subAgentRows] =
    await Promise.all([
      db
        .select()
        .from(agents)
        .where(eq(agents.id, id))
        .limit(1)
        .then((rows) => rows[0]),
      db
        .select({ id: skills.id, name: skills.name, isActive: skills.isActive })
        .from(agentSkills)
        .innerJoin(skills, eq(agentSkills.skillId, skills.id))
        .where(eq(agentSkills.agentId, id)),
      db
        .select({ id: tools.id, name: tools.name, isActive: tools.isActive })
        .from(agentTools)
        .innerJoin(tools, eq(agentTools.toolId, tools.id))
        .where(eq(agentTools.agentId, id)),
      db
        .select({
          serverId: mcpServers.id,
          serverName: mcpServers.name,
          serverIsActive: mcpServers.isActive,
          toolName: agentMcpTools.toolName,
          needsApproval: agentMcpTools.needsApproval,
        })
        .from(agentMcpTools)
        .innerJoin(mcpServers, eq(agentMcpTools.serverId, mcpServers.id))
        .where(eq(agentMcpTools.agentId, id)),
      db
        .select({ id: agents.id, name: agents.name, isActive: agents.isActive })
        .from(agentSubAgents)
        .innerJoin(agents, eq(agentSubAgents.childId, agents.id))
        .where(eq(agentSubAgents.parentId, id)),
    ]);

  if (!agentRow) return null;

  const mcpByServer = new Map<string, McpRefGroup>();
  for (const row of mcpRows) {
    let group = mcpByServer.get(row.serverId);
    if (!group) {
      group = {
        serverId: row.serverId,
        serverName: row.serverName,
        status: row.serverIsActive ? "ok" : "inactive",
        tools: [],
      };
      mcpByServer.set(row.serverId, group);
    }
    group.tools.push({ name: row.toolName, needsApproval: row.needsApproval });
  }
  const mcpToolGroups = [...mcpByServer.values()];

  const warnings: Warning[] = [
    ...skillRows
      .filter((row) => !row.isActive)
      .map((row) => ({ type: "skill" as const, id: row.id, name: row.name })),
    ...toolRows
      .filter((row) => !row.isActive)
      .map((row) => ({ type: "tool" as const, id: row.id, name: row.name })),
    ...mcpToolGroups
      .filter((group) => group.status === "inactive")
      .map((group) => ({
        type: "mcp_server" as const,
        id: group.serverId,
        name: group.serverName,
      })),
    ...subAgentRows
      .filter((row) => !row.isActive)
      .map((row) => ({
        type: "sub_agent" as const,
        id: row.id,
        name: row.name,
      })),
  ];

  return {
    ...agentRow,
    skills: skillRows,
    tools: toolRows,
    mcpTools: mcpToolGroups,
    subAgents: subAgentRows,
    warnings,
  };
}

export async function getAgentFormCatalogs(excludeAgentId?: string) {
  const [skillRows, toolRows, mcpRows, agentRows] = await Promise.all([
    db.select().from(skills).where(eq(skills.isActive, true)),
    db.select().from(tools).where(eq(tools.isActive, true)),
    db
      .select({ id: mcpServers.id, name: mcpServers.name })
      .from(mcpServers)
      .where(eq(mcpServers.isActive, true)),
    db.select().from(agents).where(eq(agents.isActive, true)),
  ]);

  return {
    skills: skillRows,
    tools: toolRows,
    mcpServers: mcpRows,
    subAgentCandidates: excludeAgentId
      ? agentRows.filter((agent) => agent.id !== excludeAgentId)
      : agentRows,
  };
}

async function getAgentsNeedingAttention() {
  const [badSkills, badTools, badMcp, badSubs] = await Promise.all([
    db
      .select({ agentId: agentSkills.agentId })
      .from(agentSkills)
      .innerJoin(skills, eq(agentSkills.skillId, skills.id))
      .where(eq(skills.isActive, false)),
    db
      .select({ agentId: agentTools.agentId })
      .from(agentTools)
      .innerJoin(tools, eq(agentTools.toolId, tools.id))
      .where(eq(tools.isActive, false)),
    db
      .select({ agentId: agentMcpTools.agentId })
      .from(agentMcpTools)
      .innerJoin(mcpServers, eq(agentMcpTools.serverId, mcpServers.id))
      .where(eq(mcpServers.isActive, false)),
    db
      .select({ agentId: agentSubAgents.parentId })
      .from(agentSubAgents)
      .innerJoin(agents, eq(agentSubAgents.childId, agents.id))
      .where(eq(agents.isActive, false)),
  ]);

  const brokenByAgent = new Map<string, number>();
  for (const rows of [badSkills, badTools, badMcp, badSubs]) {
    for (const row of rows) {
      brokenByAgent.set(row.agentId, (brokenByAgent.get(row.agentId) ?? 0) + 1);
    }
  }
  if (brokenByAgent.size === 0) return [];

  const named = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(inArray(agents.id, [...brokenByAgent.keys()]));

  return named
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      brokenRefs: brokenByAgent.get(agent.id) ?? 0,
    }))
    .sort((a, b) => b.brokenRefs - a.brokenRefs);
}

// Needs review = failed or carrying an open note; both stay useful at 10,000 runs.
const needsReviewFilter = or(
  eq(agentRuns.status, "error"),
  sql`exists (
    select 1 from ${fixDrafts}
    where ${fixDrafts.runId} = ${agentRuns.id} and ${fixDrafts.status} = 'open'
  )`,
);

export async function getDashboardData() {
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    agentTotal,
    agentActive,
    toolCount,
    skillCount,
    mcpCount,
    runCount,
    needsReviewCount,
    needsReview,
    agentIssues,
    activityDaily,
  ] = await Promise.all([
    db
      .select({ value: count() })
      .from(agents)
      .then((rows) => rows[0]?.value ?? 0),
    db
      .select({ value: count() })
      .from(agents)
      .where(eq(agents.isActive, true))
      .then((rows) => rows[0]?.value ?? 0),
    db
      .select({ value: count() })
      .from(tools)
      .then((rows) => rows[0]?.value ?? 0),
    db
      .select({ value: count() })
      .from(skills)
      .then((rows) => rows[0]?.value ?? 0),
    db
      .select({ value: count() })
      .from(mcpServers)
      .then((rows) => rows[0]?.value ?? 0),
    db
      .select({ value: count() })
      .from(agentRuns)
      .then((rows) => rows[0]?.value ?? 0),
    db
      .select({ value: count() })
      .from(agentRuns)
      .where(needsReviewFilter)
      .then((rows) => rows[0]?.value ?? 0),
    db
      .select({
        id: agentRuns.id,
        source: agentRuns.source,
        status: agentRuns.status,
        createdAt: agentRuns.createdAt,
        agentName: agents.name,
        openDrafts: openDraftCount,
      })
      .from(agentRuns)
      .innerJoin(agents, eq(agentRuns.agentId, agents.id))
      .where(needsReviewFilter)
      .orderBy(desc(agentRuns.createdAt))
      .limit(6),
    getAgentsNeedingAttention(),
    db
      .select({
        day: runDay,
        runs: sql<number>`count(*)::int`,
        errors: sql<number>`(count(*) filter (where ${agentRuns.status} = 'error'))::int`,
      })
      .from(agentRuns)
      .where(gte(agentRuns.createdAt, since7d))
      .groupBy(sql`1`)
      .orderBy(sql`1`),
  ]);

  const activityRuns = activityDaily.reduce((sum, row) => sum + row.runs, 0);
  const activityErrors = activityDaily.reduce(
    (sum, row) => sum + row.errors,
    0,
  );

  return {
    counts: {
      agents: agentTotal,
      activeAgents: agentActive,
      runs: runCount,
      tools: toolCount,
      skills: skillCount,
      mcp: mcpCount,
    },
    needsReview,
    needsReviewCount,
    agentIssues,
    activity: {
      runs: activityRuns,
      errors: activityErrors,
      daily: activityDaily,
    },
  };
}
