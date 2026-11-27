import { getAgentCriteria, getAgentDetail } from "@/lib/queries";
import { listAgentKnowledge } from "@/lib/queries-knowledge";
import { listAgentSchedules } from "@/lib/queries-schedules";

export type AgentContext = NonNullable<
  Awaited<ReturnType<typeof loadAgentContext>>
>;

export async function loadAgentContext(agentId: string) {
  const [agent, knowledge, schedules, criteria] = await Promise.all([
    getAgentDetail(agentId),
    listAgentKnowledge(agentId),
    listAgentSchedules(agentId),
    getAgentCriteria(agentId),
  ]);
  if (!agent) return null;
  const memory = agent.memoryStores.find((store) => store.isActive);
  return {
    id: agent.id,
    name: agent.name,
    slug: agent.slug,
    description: agent.description ?? "",
    model: agent.model,
    systemPrompt: agent.systemPrompt ?? "",
    maxSteps: agent.maxSteps,
    skillIds: agent.skills.map((skill) => skill.id),
    toolIds: agent.tools.map((tool) => tool.id),
    subAgentIds: agent.subAgents.map((subAgent) => subAgent.id),
    mcpTools: agent.mcpTools.flatMap((group) =>
      group.tools.map((tool) => ({
        serverId: group.serverId,
        toolName: tool.name,
        needsApproval: tool.needsApproval,
      })),
    ),
    knowledge: knowledge.map((link) => ({
      collectionId: link.collectionId,
      mode: link.mode,
    })),
    memory: memory
      ? {
          type: memory.scope,
          purpose: memory.purpose,
          requireApproval: memory.requireApproval,
          ...(memory.scope === "custom" ? { memoryKey: memory.memoryKey } : {}),
        }
      : { type: "none" as const },
    schedules: schedules.map((schedule) => ({
      name: schedule.name,
      frequency: schedule.frequency,
      timeOfDay: schedule.timeOfDay,
      isActive: schedule.isActive,
    })),
    criteria: criteria.criteria.map((criterion) => ({
      question: criterion.question,
      isActive: criterion.isActive,
      last30Days: criterion.stats,
    })),
  };
}
