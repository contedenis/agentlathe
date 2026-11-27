import {
  agentKnowledge,
  agentMcpTools,
  agentSkills,
  agentSubAgents,
  agents,
  db,
  isUuid,
  type KnowledgeMode,
  knowledgeCollections,
  type MemoryScope,
  mcpServers,
  memoryStores,
  skills,
} from "@agentlathe/db";
import { and, asc, eq, or } from "drizzle-orm";

export type AgentRow = typeof agents.$inferSelect;

export type SkillRow = {
  id: string;
  name: string;
  description: string;
  content: string;
  script?: string | null;
  inputSchema?: unknown;
  needsApproval?: boolean;
};

export type SubAgentRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
};

export type McpServerGroup = {
  id: string;
  name: string;
  serverUrl: string;
  authConfig: unknown;
  toolNames: string[];
  approvalToolNames: string[];
};

export async function loadActiveAgent(
  idOrSlugOrName: string,
): Promise<AgentRow | null> {
  if (isUuid(idOrSlugOrName)) {
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, idOrSlugOrName))
      .limit(1);
    return agent?.isActive ? agent : null;
  }

  const rows = await db
    .select()
    .from(agents)
    .where(or(eq(agents.slug, idOrSlugOrName), eq(agents.name, idOrSlugOrName)))
    .limit(2);
  const agent =
    rows.find((row) => row.slug === idOrSlugOrName) ??
    rows.find((row) => row.name === idOrSlugOrName);
  return agent?.isActive ? agent : null;
}

export async function loadAgentConfig(agentId: string): Promise<AgentRow> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agent) throw new Error(`Agent ${agentId} not found`);
  return agent;
}

export async function loadSkills(agentId: string): Promise<SkillRow[]> {
  return db
    .select({
      id: skills.id,
      name: skills.name,
      description: skills.description,
      content: skills.content,
      script: skills.script,
      inputSchema: skills.inputSchema,
      needsApproval: skills.needsApproval,
    })
    .from(agentSkills)
    .innerJoin(skills, eq(agentSkills.skillId, skills.id))
    .where(and(eq(agentSkills.agentId, agentId), eq(skills.isActive, true)));
}

export type MemoryStoreRow = {
  id: string;
  name: string;
  agentName: string;
  scope: MemoryScope;
  purpose: string;
  charLimit: number;
  requireApproval: boolean;
  expectedKey: string | null;
};

const MEMORY_SCOPE_ORDER: MemoryScope[] = ["agent", "agent_subject", "custom"];

export async function loadMemoryStores(
  agentId: string,
): Promise<MemoryStoreRow[]> {
  const rows = await db
    .select({
      id: memoryStores.id,
      name: memoryStores.name,
      agentName: agents.name,
      scope: memoryStores.scope,
      purpose: memoryStores.purpose,
      charLimit: memoryStores.charLimit,
      requireApproval: memoryStores.requireApproval,
      expectedKey: memoryStores.memoryKey,
    })
    .from(memoryStores)
    .innerJoin(agents, eq(agents.id, memoryStores.ownerAgentId))
    .where(
      and(
        eq(memoryStores.ownerAgentId, agentId),
        eq(memoryStores.isActive, true),
      ),
    );
  return rows
    .map((row) => ({ ...row, scope: row.scope as MemoryScope }))
    .sort(
      (a, b) =>
        MEMORY_SCOPE_ORDER.indexOf(a.scope) -
        MEMORY_SCOPE_ORDER.indexOf(b.scope),
    )
    .slice(0, 1);
}

export async function loadSubAgents(parentId: string): Promise<SubAgentRow[]> {
  return db
    .select({
      id: agents.id,
      name: agents.name,
      slug: agents.slug,
      description: agents.description,
    })
    .from(agentSubAgents)
    .innerJoin(agents, eq(agentSubAgents.childId, agents.id))
    .where(
      and(eq(agentSubAgents.parentId, parentId), eq(agents.isActive, true)),
    );
}

export async function loadMcpServers(
  agentId: string,
): Promise<McpServerGroup[]> {
  const rows = await db
    .select({
      id: mcpServers.id,
      name: mcpServers.name,
      serverUrl: mcpServers.serverUrl,
      authConfig: mcpServers.authConfig,
      toolName: agentMcpTools.toolName,
      needsApproval: agentMcpTools.needsApproval,
    })
    .from(agentMcpTools)
    .innerJoin(mcpServers, eq(agentMcpTools.serverId, mcpServers.id))
    .where(
      and(eq(agentMcpTools.agentId, agentId), eq(mcpServers.isActive, true)),
    );

  const byServer = new Map<string, McpServerGroup>();
  for (const row of rows) {
    let group = byServer.get(row.id);
    if (!group) {
      group = {
        id: row.id,
        name: row.name,
        serverUrl: row.serverUrl,
        authConfig: row.authConfig,
        toolNames: [],
        approvalToolNames: [],
      };
      byServer.set(row.id, group);
    }
    group.toolNames.push(row.toolName);
    if (row.needsApproval) group.approvalToolNames.push(row.toolName);
  }
  return [...byServer.values()];
}

export type KnowledgeCollectionRow = {
  id: string;
  name: string;
  description: string;
  mode: KnowledgeMode;
};

export async function loadKnowledgeCollections(
  agentId: string,
): Promise<KnowledgeCollectionRow[]> {
  const rows = await db
    .select({
      id: knowledgeCollections.id,
      name: knowledgeCollections.name,
      description: knowledgeCollections.description,
      mode: agentKnowledge.mode,
    })
    .from(agentKnowledge)
    .innerJoin(
      knowledgeCollections,
      eq(knowledgeCollections.id, agentKnowledge.collectionId),
    )
    .where(eq(agentKnowledge.agentId, agentId))
    .orderBy(asc(knowledgeCollections.name));
  return rows.map((row) => ({ ...row, mode: row.mode as KnowledgeMode }));
}
