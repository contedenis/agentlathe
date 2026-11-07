import { AgentForm } from "@/components/forms/agent-form";
import { PageHeader } from "@/components/page-header";
import { getOpenRouterModels } from "@/lib/openrouter-models";
import { getAgentFormCatalogs } from "@/lib/queries";
import { listCollectionOptions } from "@/lib/queries-knowledge";

export default async function NewAgentPage() {
  const [catalogs, collections, models] = await Promise.all([
    getAgentFormCatalogs(),
    listCollectionOptions(),
    getOpenRouterModels(),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Agent · configuration"
        title="New agent"
        description="Define the model, system prompt and tools. It gets exposed as an OpenAI-compatible model."
      />
      <AgentForm
        catalogs={catalogs}
        collections={collections}
        models={models}
      />
    </div>
  );
}
