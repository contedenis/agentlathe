import { agentSlug } from "@agentlathe/db/naming";
import { agentCreateSchema } from "@/app/api/agents/schema";
import type { BuilderCatalog } from "./catalog";
import {
  type AgentConfigProposal,
  draftBody,
  proposalToDraft,
} from "./proposal";

export type ProposalContext = {
  catalog: BuilderCatalog;
  takenNames: Set<string>;
  takenSlugs: Set<string>;
  modelIds: Set<string>;
  mcpToolsOf: (serverId: string) => Promise<Set<string> | null>;
  attached?: Set<string>;
};

function unknownIds(ids: string[], known: Array<{ id: string }>): string[] {
  const valid = new Set(known.map((item) => item.id));
  return ids.filter((id) => !valid.has(id));
}

export async function checkAgentProposal(
  proposal: AgentConfigProposal,
  context: ProposalContext,
): Promise<string[]> {
  const problems: string[] = [];
  const { catalog } = context;

  let body: ReturnType<typeof draftBody> | undefined;
  try {
    body = draftBody(proposalToDraft(proposal));
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (body) {
    const parsed = agentCreateSchema.safeParse(body);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        problems.push(
          `${issue.path.join(".") || "proposal"}: ${issue.message}`,
        );
  }

  if (context.takenNames.has(proposal.name))
    problems.push(`An agent named "${proposal.name}" already exists.`);
  const slug = proposal.slug ?? agentSlug(proposal.name);
  if (context.takenSlugs.has(slug))
    problems.push(`The ID "${slug}" is taken; pick another slug.`);
  if (context.modelIds.size > 0 && !context.modelIds.has(proposal.model))
    problems.push(
      `"${proposal.model}" is not a model of this instance's provider; use search_models.`,
    );

  const references: Array<[string, string[], Array<{ id: string }>]> = [
    ["skillIds", proposal.skillIds, catalog.skills],
    ["toolIds", proposal.toolIds, catalog.httpTools],
    ["subAgentIds", proposal.subAgentIds, catalog.agents],
    [
      "knowledge",
      proposal.knowledge.map((link) => link.collectionId),
      catalog.knowledge,
    ],
    [
      "mcpTools",
      proposal.mcpTools.map((tool) => tool.serverId),
      catalog.mcpServers,
    ],
  ];
  for (const [field, ids, known] of references)
    for (const id of unknownIds(ids, known))
      if (!context.attached?.has(id))
        problems.push(`${field}: "${id}" is not an id from the catalog.`);

  const serverIds = [
    ...new Set(proposal.mcpTools.map((tool) => tool.serverId)),
  ].filter((id) => catalog.mcpServers.some((server) => server.id === id));
  const offered = await Promise.all(
    serverIds.map(async (id) => [id, await context.mcpToolsOf(id)] as const),
  );
  for (const [serverId, names] of offered) {
    if (!names) continue;
    for (const tool of proposal.mcpTools)
      if (tool.serverId === serverId && !names.has(tool.toolName))
        problems.push(
          `mcpTools: the server ${serverId} offers no tool named "${tool.toolName}"; use list_mcp_tools.`,
        );
  }
  return problems;
}
