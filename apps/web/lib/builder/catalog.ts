import { db, mcpServers } from "@agentlathe/db";
import { discoverMcpTools } from "@agentlathe/runner";
import { eq } from "drizzle-orm";
import { getOpenRouterModels } from "@/lib/openrouter-models";
import { getAgentFormCatalogs } from "@/lib/queries";
import { listCollectionOptions } from "@/lib/queries-knowledge";

export type BuilderCatalog = Awaited<ReturnType<typeof loadBuilderCatalog>>;

export async function loadBuilderCatalog(excludeAgentId?: string) {
  const [catalogs, collections] = await Promise.all([
    getAgentFormCatalogs(excludeAgentId),
    listCollectionOptions(),
  ]);
  return {
    skills: catalogs.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      runsScript: Boolean(skill.script),
    })),
    httpTools: catalogs.tools.map((tool) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      needsApproval: tool.needsApproval,
    })),
    mcpServers: catalogs.mcpServers.map((server) => ({
      id: server.id,
      name: server.name,
    })),
    agents: catalogs.subAgentCandidates.map((agent) => ({
      id: agent.id,
      name: agent.name,
      slug: agent.slug,
      description: agent.description,
    })),
    knowledge: collections.map((collection) => ({
      id: collection.id,
      name: collection.name,
      description: collection.description,
      chars: collection.chars,
    })),
  };
}

export async function listMcpServerTools(
  serverId: string,
): Promise<Array<{ name: string; description?: string }>> {
  const [server] = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId))
    .limit(1);
  if (!server?.isActive) throw new Error("No active MCP server has that id.");
  const tools = await discoverMcpTools(server);
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
  }));
}

const MODEL_MATCHES = 20;

export async function searchModels(query: string) {
  const needle = query.trim().toLowerCase();
  const models = await getOpenRouterModels();
  return models
    .filter(
      (model) =>
        model.id.toLowerCase().includes(needle) ||
        model.name.toLowerCase().includes(needle),
    )
    .slice(0, MODEL_MATCHES)
    .map((model) => ({
      id: model.id,
      name: model.name,
      contextLength: model.contextLength,
      promptPrice: model.promptPrice,
      completionPrice: model.completionPrice,
    }));
}
