import { getSettings } from "@agentlathe/db";
import { fallbackContextLimit } from "@agentlathe/runner";
import { AgentFormWithBuilder } from "@/components/forms/agent-form-with-builder";
import { PageHeader } from "@/components/page-header";
import { getOpenRouterModels } from "@/lib/openrouter-models";
import { getAgentFormCatalogs } from "@/lib/queries";
import { listCollectionOptions } from "@/lib/queries-knowledge";

export default async function NewAgentPage() {
  const [catalogs, collections, models, settings] = await Promise.all([
    getAgentFormCatalogs(),
    listCollectionOptions(),
    getOpenRouterModels(),
    getSettings(),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Agent · configuration"
        title="New agent"
        description="Define the model, system prompt and tools. It gets exposed as an OpenAI-compatible model."
      />
      <AgentFormWithBuilder
        builderConfigured={Boolean(settings.builderModel)}
        catalogs={catalogs}
        collections={collections}
        models={models}
        contextFallback={fallbackContextLimit()}
      />
    </div>
  );
}
