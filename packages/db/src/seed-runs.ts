import { eq } from "drizzle-orm";
import { isMain } from "./cli-entry";
import { db } from "./client";
import { httpToolName, mcpToolName, subAgentToolName } from "./naming";
import {
  type AgentRunCallKind,
  type AgentRunSource,
  agentMcpTools,
  agentRunCalls,
  agentRuns,
  agentSkills,
  agentSubAgents,
  agents,
  agentTools,
  mcpServers,
  skills,
  tools,
} from "./schema";

const DAYS = Number(process.env.SEED_RUN_DAYS ?? 30);
const RUNS_PER_DAY = Number(process.env.SEED_RUNS_PER_DAY ?? 9);
const DAY_MS = 24 * 60 * 60 * 1000;

type Capability = {
  kind: AgentRunCallKind;
  name: string;
  needsApproval: boolean;
  weight: number;
};

type Trend = "growing" | "declining" | "flat" | "dormant";

type AgentProfile = {
  id: string;
  name: string;
  model: string;
  sources: AgentRunSource[];
  baseDurationMs: number;
  baseInputTokens: number;
  capabilities: Capability[];
  trend: Trend;
};

const TRENDS: Trend[] = [
  "growing",
  "flat",
  "declining",
  "growing",
  "flat",
  "dormant",
];

function trendWeight(trend: Trend, progress: number): number {
  switch (trend) {
    case "growing":
      return 0.25 + progress * 1.6;
    case "declining":
      return 1.7 - progress * 1.5;
    case "dormant":
      return 0;
    default:
      return 1;
  }
}

function pickWeighted(
  profiles: AgentProfile[],
  progress: number,
): AgentProfile {
  const weights = profiles.map((profile) =>
    trendWeight(profile.trend, progress),
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = Math.random() * total;
  for (const [index, weight] of weights.entries()) {
    roll -= weight;
    if (roll <= 0) return profiles[index];
  }
  return profiles[profiles.length - 1];
}

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function jitter(base: number, spread = 0.35): number {
  return Math.max(1, Math.round(base * (1 + (Math.random() * 2 - 1) * spread)));
}

function duration(base: number): number {
  const slow = Math.random() < 0.12 ? 2.5 + Math.random() * 3 : 1;
  return jitter(base * slow, 0.4);
}

async function loadProfiles(): Promise<AgentProfile[]> {
  const rows = await db
    .select({ id: agents.id, name: agents.name, model: agents.model })
    .from(agents)
    .where(eq(agents.isActive, true));

  const profiles = await Promise.all(
    rows.map(async (row, agentIndex) => {
      const [toolRows, skillRows, mcpRows, subRows] = await Promise.all([
        db
          .select({ name: tools.name, needsApproval: tools.needsApproval })
          .from(agentTools)
          .innerJoin(tools, eq(agentTools.toolId, tools.id))
          .where(eq(agentTools.agentId, row.id)),
        db
          .select({ name: skills.name })
          .from(agentSkills)
          .innerJoin(skills, eq(agentSkills.skillId, skills.id))
          .where(eq(agentSkills.agentId, row.id)),
        db
          .select({
            server: mcpServers.name,
            tool: agentMcpTools.toolName,
          })
          .from(agentMcpTools)
          .innerJoin(mcpServers, eq(agentMcpTools.serverId, mcpServers.id))
          .where(eq(agentMcpTools.agentId, row.id)),
        db
          .select({ slug: agents.slug })
          .from(agentSubAgents)
          .innerJoin(agents, eq(agentSubAgents.childId, agents.id))
          .where(eq(agentSubAgents.parentId, row.id)),
      ]);

      const capabilities: Capability[] = [
        ...toolRows.map((tool) => ({
          kind: "tool" as const,
          name: httpToolName(tool.name),
          needsApproval: tool.needsApproval,
          weight: tool.needsApproval ? 0.25 : 0.6,
        })),
        ...skillRows.map((skill) => ({
          kind: "skill" as const,
          name: skill.name,
          needsApproval: false,
          weight: 0.7,
        })),
        ...mcpRows.map((mcp) => ({
          kind: "mcp" as const,
          name: mcpToolName(mcp.server, mcp.tool),
          needsApproval: false,
          weight: 0.12,
        })),
        ...subRows.map((sub) => ({
          kind: "sub_agent" as const,
          name: subAgentToolName(sub.slug),
          needsApproval: false,
          weight: 0.55,
        })),
      ];

      for (const [index, cap] of capabilities.entries()) {
        const dead =
          cap.kind === "mcp"
            ? index % 5 !== 0
            : cap.kind === "tool" && index % 4 === 3;
        if (dead) cap.weight = 0;
      }

      const sources: AgentRunSource[] =
        subRows.length > 0
          ? ["dashboard", "v1", "mcp", "v1", "mcp"]
          : capabilities.some((cap) => cap.kind === "mcp")
            ? ["dashboard", "mcp", "v1"]
            : ["dashboard", "dashboard", "v1"];

      return {
        id: row.id,
        name: row.name,
        model: row.model,
        sources,
        baseDurationMs:
          2500 + capabilities.length * 900 + subRows.length * 4000,
        baseInputTokens: 1800 + capabilities.length * 450,
        capabilities,
        trend: TRENDS[agentIndex % TRENDS.length],
      };
    }),
  );
  return profiles;
}

export async function seedRuns() {
  const profiles = await loadProfiles();
  if (profiles.length === 0) {
    console.log("seed-runs: no active agents.");
    return;
  }

  const now = Date.now();
  const runValues: (typeof agentRuns.$inferInsert)[] = [];
  const callValues: (typeof agentRunCalls.$inferInsert)[] = [];

  for (let dayOffset = DAYS - 1; dayOffset >= 0; dayOffset--) {
    const dayStart = now - dayOffset * DAY_MS;
    const weekday = new Date(dayStart).getDay();
    const volume =
      weekday === 0 || weekday === 6
        ? Math.round(RUNS_PER_DAY * 0.3)
        : jitter(RUNS_PER_DAY, 0.5);

    const progress = (DAYS - 1 - dayOffset) / Math.max(DAYS - 1, 1);

    for (let i = 0; i < volume; i++) {
      const profile = pickWeighted(profiles, progress);
      const source = pick(profile.sources);
      const failed = Math.random() < 0.04;

      const chosen = profile.capabilities.filter(
        (cap) => Math.random() < cap.weight,
      );
      const approvalCaps = chosen.filter((cap) => cap.needsApproval);
      const approvalsRequested = source === "mcp" ? approvalCaps.length : 0;
      const grantedCaps = new Set(
        approvalCaps.filter(() => Math.random() < 0.7),
      );
      const approvalsGranted = source === "mcp" ? grantedCaps.size : 0;

      const inputTokens = jitter(
        profile.baseInputTokens + chosen.length * 700,
        0.3,
      );
      const outputTokens = jitter(120 + chosen.length * 90, 0.5);

      const createdAt = new Date(
        dayStart -
          Math.floor(Math.random() * DAY_MS * 0.6) -
          Math.floor(Math.random() * 6) * 60 * 60 * 1000,
      );

      const runId = crypto.randomUUID();
      runValues.push({
        id: runId,
        agentId: profile.id,
        source,
        status: failed ? "error" : "ok",
        model: profile.model,
        durationMs: duration(profile.baseDurationMs),
        steps: 1 + chosen.length,
        toolCalls: chosen.length,
        inputTokens: failed ? null : inputTokens,
        outputTokens: failed ? null : outputTokens,
        approvalsRequested,
        approvalsGranted,
        error: failed ? "Upstream tool returned 502" : null,
        createdAt,
      });

      for (const cap of chosen) {
        const denied =
          source === "mcp" && cap.needsApproval && !grantedCaps.has(cap);
        callValues.push({
          runId,
          kind: cap.kind,
          name: cap.name,
          durationMs: denied
            ? null
            : cap.kind === "skill"
              ? jitter(3, 0.8)
              : jitter(650, 0.7),
          status: denied
            ? ("denied" as const)
            : Math.random() < 0.05
              ? ("error" as const)
              : ("ok" as const),
        });
      }
    }
  }

  const INSERT_CHUNK = 1000;
  await db.transaction(async (tx) => {
    for (let i = 0; i < runValues.length; i += INSERT_CHUNK) {
      await tx.insert(agentRuns).values(runValues.slice(i, i + INSERT_CHUNK));
    }
    for (let i = 0; i < callValues.length; i += INSERT_CHUNK) {
      await tx
        .insert(agentRunCalls)
        .values(callValues.slice(i, i + INSERT_CHUNK));
    }
  });

  console.log(
    `seed-runs: ${runValues.length} synthetic runs and ${callValues.length} calls over ${DAYS} days, across ${profiles.length} agents.`,
  );
  console.log(
    "seed-runs: this is simulated data to populate the dashboard, not real model calls.",
  );
}

if (isMain(import.meta.url)) {
  seedRuns()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
