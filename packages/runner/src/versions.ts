import { createHash } from "node:crypto";
import { agentVersions, db } from "@agentlathe/db";
import { and, eq } from "drizzle-orm";
import { MAX_DEPTH } from "./context";
import {
  type AgentRow,
  loadAgentConfig,
  loadMcpServers,
  loadSkills,
  loadSubAgents,
  type McpServerGroup,
  type SkillRow,
  type SubAgentRow,
} from "./loaders";
import { type HttpToolRow, loadHttpToolRows } from "./tools";

export type AgentConfig = {
  agent: Pick<AgentRow, "model" | "systemPrompt" | "maxSteps">;
  skills: SkillRow[];
  httpTools: HttpToolRow[];
  mcpServers: McpServerGroup[];
  subAgents: SubAgentRow[];
};

export type AgentConfigSnapshot = ReturnType<typeof agentConfigSnapshot>;

export type AgentVersionSnapshot = AgentConfigSnapshot & {
  descendants: Array<{ slug: string; hash: string }>;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonicalize((value as Record<string, unknown>)[key]),
        ]),
    );
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sortCanonical<T>(items: T[]): T[] {
  return items
    .map((item) => ({ item, key: canonicalJson(item) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ item }) => item);
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

export function maskUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return digest(raw);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return digest(raw);
  const bare =
    !url.username &&
    !url.password &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash;
  return bare ? raw : `${url.protocol}//${url.host}/${digest(raw)}`;
}

export function agentConfigSnapshot(config: AgentConfig) {
  return {
    model: config.agent.model,
    systemPrompt: config.agent.systemPrompt ?? "",
    maxSteps: config.agent.maxSteps,
    skills: sortCanonical(
      config.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        content: skill.content,
      })),
    ),
    httpTools: sortCanonical(
      config.httpTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        endpoint: maskUrl(tool.endpoint),
        inputSchema: tool.inputSchema,
        needsApproval: tool.needsApproval,
      })),
    ),
    mcpServers: sortCanonical(
      config.mcpServers.map((server) => ({
        name: server.name,
        serverUrl: maskUrl(server.serverUrl),
        toolNames: [...server.toolNames].sort(),
        approvalToolNames: [...server.approvalToolNames].sort(),
      })),
    ),
    subAgents: sortCanonical(
      config.subAgents.map((child) => ({
        slug: child.slug,
        description: child.description ?? child.name,
      })),
    ),
  };
}

export function hashSnapshot(snapshot: unknown): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

export function agentVersionSnapshot(
  root: AgentConfig,
  descendants: Array<{ slug: string; config: AgentConfig }>,
): AgentVersionSnapshot {
  return {
    ...agentConfigSnapshot(root),
    descendants: descendants
      .map(({ slug, config }) => ({
        slug,
        hash: hashSnapshot(agentConfigSnapshot(config)),
      }))
      .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)),
  };
}

export async function computeAgentVersion(
  agentId: string,
  load: (agentId: string) => Promise<AgentConfig>,
): Promise<{ snapshot: AgentVersionSnapshot; hash: string }> {
  const root = await load(agentId);
  const visited = new Set([agentId]);
  const descendants: Array<{ slug: string; config: AgentConfig }> = [];
  let frontier = root.subAgents;
  for (let depth = 1; depth <= MAX_DEPTH && frontier.length > 0; depth++) {
    const level: SubAgentRow[] = [];
    for (const child of frontier) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      level.push(child);
    }
    const configs = await Promise.all(level.map((child) => load(child.id)));
    level.forEach((child, i) => {
      descendants.push({ slug: child.slug, config: configs[i] });
    });
    frontier = configs.flatMap((config) => config.subAgents);
  }
  const snapshot = agentVersionSnapshot(root, descendants);
  return { snapshot, hash: hashSnapshot(snapshot) };
}

async function loadConfig(agentId: string): Promise<AgentConfig> {
  const [agent, skills, httpTools, mcpServers, subAgents] = await Promise.all([
    loadAgentConfig(agentId),
    loadSkills(agentId),
    loadHttpToolRows(agentId),
    loadMcpServers(agentId),
    loadSubAgents(agentId),
  ]);
  return { agent, skills, httpTools, mcpServers, subAgents };
}

export async function resolveAgentVersion(agentId: string): Promise<string> {
  const { snapshot, hash } = await computeAgentVersion(agentId, loadConfig);

  const [inserted] = await db
    .insert(agentVersions)
    .values({ agentId, hash, snapshot })
    .onConflictDoNothing({
      target: [agentVersions.agentId, agentVersions.hash],
    })
    .returning({ id: agentVersions.id });
  if (inserted) return inserted.id;

  const [existing] = await db
    .select({ id: agentVersions.id })
    .from(agentVersions)
    .where(
      and(eq(agentVersions.agentId, agentId), eq(agentVersions.hash, hash)),
    )
    .limit(1);
  if (!existing)
    throw new Error(`Agent version ${hash} of ${agentId} vanished`);
  return existing.id;
}
