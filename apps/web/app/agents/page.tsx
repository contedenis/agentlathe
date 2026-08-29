import Link from "next/link";
import { AgentsList } from "@/components/agents-list";
import { EmptyState } from "@/components/empty-state";
import { LIST_SHELL_CLASS } from "@/components/list-search";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { listAgents } from "@/lib/queries";

export default async function AgentsPage() {
  const agents = await listAgents();

  return (
    <div className={LIST_SHELL_CLASS}>
      <PageHeader
        eyebrow="Workshop · agents"
        title="Agents"
        description="Each agent combines a model, a system prompt and tools, and is exposed as an OpenAI-compatible model."
        action={
          <Button nativeButton={false} render={<Link href="/agents/new" />}>
            New agent
          </Button>
        }
      />
      {agents.length === 0 ? (
        <EmptyState
          title="No agents yet"
          description="An agent composes a model, a system prompt and tools (HTTP, MCP, sub-agents) and is exposed as an OpenAI-compatible model."
          action={
            <Button nativeButton={false} render={<Link href="/agents/new" />}>
              Create agent
            </Button>
          }
        />
      ) : (
        <AgentsList agents={agents} />
      )}
    </div>
  );
}
