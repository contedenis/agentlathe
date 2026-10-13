import { notFound } from "next/navigation";
import { AgentForm } from "@/components/forms/agent-form";
import { PageHeader } from "@/components/page-header";
import { getOpenRouterModels } from "@/lib/openrouter-models";
import { getAgentDetail, getAgentFormCatalogs } from "@/lib/queries";

export default async function EditAgentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [agent, catalogs, models] = await Promise.all([
    getAgentDetail(id),
    getAgentFormCatalogs(id),
    getOpenRouterModels(),
  ]);
  if (!agent) notFound();

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Agent · configuration"
        title={`Edit ${agent.name}`}
        description={agent.description ?? undefined}
      />
      <AgentForm
        catalogs={catalogs}
        models={models}
        initial={{
          id: agent.id,
          name: agent.name,
          slug: agent.slug,
          description: agent.description,
          model: agent.model,
          systemPrompt: agent.systemPrompt,
          maxSteps: agent.maxSteps,
          recordTraffic: agent.recordTraffic,
          autoEvaluate: agent.autoEvaluate,
          skillIds: agent.skills.map((s) => s.id),
          toolIds: agent.tools.map((t) => t.id),
          subAgentIds: agent.subAgents.map((a) => a.id),
          mcpTools: agent.mcpTools.flatMap((group) =>
            group.tools.map((tool) => ({
              serverId: group.serverId,
              toolName: tool.name,
              needsApproval: tool.needsApproval,
            })),
          ),
        }}
      />
    </div>
  );
}
