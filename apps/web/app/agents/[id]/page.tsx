import { getContextLimit } from "@agentlathe/runner";
import {
  ArrowUpRightIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActiveBadge } from "@/components/active-badge";
import { AgentConnect } from "@/components/agent-connect";
import { AgentPlayground } from "@/components/agent-playground";
import { AgentTabs } from "@/components/agent-tabs";
import { AgentWarningsBanner } from "@/components/agent-warnings-banner";
import { BreadcrumbTitle } from "@/components/breadcrumb-title";
import { CriteriaPanel } from "@/components/criteria-panel";
import { DeleteResourceButton } from "@/components/delete-resource-button";
import { PageHeader } from "@/components/page-header";
import { ToggleActiveButton } from "@/components/toggle-active-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { KNOWLEDGE_MODE_LABEL } from "@/lib/knowledge-modes";
import { MEMORY_SCOPE_LABEL } from "@/lib/memory-rules";
import {
  getAgentCriteria,
  getAgentDetail,
  getCriteriaCopySources,
} from "@/lib/queries";
import { listAgentKnowledge } from "@/lib/queries-knowledge";
import { countRunWarnings, WARNING_WINDOW_DAYS } from "@/lib/queries-memory";
import { listAgentSchedules } from "@/lib/queries-schedules";
import { describeTrigger } from "@/lib/scheduler/calendar";

const MEMORY_CONTEXT_SHARE = 0.25;

function RefList({
  items,
  emptyLabel,
}: {
  items: { id: string; name: string; isActive: boolean | null }[];
  emptyLabel: string;
}) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <Badge key={item.id} variant={item.isActive ? "secondary" : "outline"}>
          {item.name}
          {!item.isActive && " (inactive)"}
        </Badge>
      ))}
    </div>
  );
}

const TABS = ["playground", "configuration", "evaluation", "connect"] as const;

export default async function AgentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  const initialTab = TABS.find((value) => value === tab) ?? "playground";
  const [
    agent,
    criteriaData,
    copySources,
    agentSchedules,
    runWarnings,
    knowledge,
  ] = await Promise.all([
    getAgentDetail(id),
    getAgentCriteria(id),
    getCriteriaCopySources(id),
    listAgentSchedules(id),
    countRunWarnings(id),
    listAgentKnowledge(id),
  ]);
  if (!agent) notFound();
  const usedMemories = agent.memoryStores.filter(
    (store) => store.isActive || store.scope === "custom",
  );
  const memoryTokens = Math.ceil(
    agent.memoryStores
      .filter((store) => store.isActive)
      .reduce((sum, store) => sum + store.charLimit, 0) / 4,
  );
  const contextLimit =
    memoryTokens > 0 ? await getContextLimit(agent.model) : 0;
  const memoryShare = contextLimit ? memoryTokens / contextLimit : 0;

  return (
    <div className="flex flex-col gap-4">
      <BreadcrumbTitle name={agent.name} />
      <PageHeader
        eyebrow="Agent · detail"
        title={agent.name}
        description={agent.description ?? undefined}
        action={<ActiveBadge isActive={agent.isActive} />}
      />

      <AgentWarningsBanner warnings={agent.warnings} />

      {memoryShare > MEMORY_CONTEXT_SHARE && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>Memory can take a large share of the context</AlertTitle>
          <AlertDescription>
            Full, its memory adds about {memoryTokens.toLocaleString("en-US")}{" "}
            tokens to every run, {Math.round(memoryShare * 100)}% of the{" "}
            {contextLimit.toLocaleString("en-US")} tokens {agent.model} takes.
            Lower its character limit or use a model with a larger context.
          </AlertDescription>
        </Alert>
      )}

      {runWarnings.length > 0 && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>Runs that ran without part of their context</AlertTitle>
          <AlertDescription>
            <ul>
              {runWarnings.map((warning) => (
                <li key={warning.message}>
                  {warning.runs} {warning.runs === 1 ? "run" : "runs"} in the
                  last {WARNING_WINDOW_DAYS} days: {warning.message}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex gap-2">
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link href={`/agents/${id}/edit`} />}
        >
          Edit
        </Button>
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link href={`/agents/${id}/edit?builder`} />}
        >
          <SparklesIcon />
          Improve with builder
        </Button>
        <ToggleActiveButton
          endpoint={`/api/agents/${id}`}
          isActive={Boolean(agent.isActive)}
        />
        <DeleteResourceButton
          endpoint={`/api/agents/${id}`}
          resourceLabel="the agent"
          redirectTo="/agents"
        />
        <div className="ml-auto flex gap-2">
          <Button
            variant="ghost"
            nativeButton={false}
            render={<Link href={`/runs?agent=${agent.id}`} />}
          >
            Runs
            <ArrowUpRightIcon />
          </Button>
          <Button
            variant="ghost"
            nativeButton={false}
            render={<Link href={`/metrics/${agent.id}`} />}
          >
            Metrics
            <ArrowUpRightIcon />
          </Button>
        </div>
      </div>

      <AgentTabs initialTab={initialTab}>
        <TabsList>
          <TabsTrigger value="playground">Playground</TabsTrigger>
          <TabsTrigger value="configuration">Configuration</TabsTrigger>
          <TabsTrigger value="evaluation">Evaluation</TabsTrigger>
          <TabsTrigger value="connect">Connect</TabsTrigger>
        </TabsList>

        <TabsContent value="playground" keepMounted className="mt-3">
          <div className="h-[32rem] lg:h-[68vh]">
            <AgentPlayground
              agentId={id}
              showMemoryKey={agent.memoryStores.some(
                (store) => store.scope === "custom",
              )}
            />
          </div>
        </TabsContent>

        <TabsContent value="configuration" className="mt-3">
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <Card>
              <CardContent>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">ID</dt>
                  <dd className="font-mono">{agent.slug}</dd>
                  <dt className="text-muted-foreground">Description</dt>
                  <dd>{agent.description ?? "—"}</dd>
                  <dt className="text-muted-foreground">Model</dt>
                  <dd className="font-mono">{agent.model}</dd>
                  <dt className="text-muted-foreground">Max steps</dt>
                  <dd>{agent.maxSteps}</dd>
                  <dt className="text-muted-foreground">External traffic</dt>
                  <dd>
                    {agent.recordTraffic
                      ? "Recorded with its messages"
                      : "Not recorded"}
                  </dd>
                  <dt className="text-muted-foreground">Evaluation</dt>
                  <dd>
                    {agent.autoEvaluate
                      ? "New runs judged automatically"
                      : "Only when re-evaluated"}
                  </dd>
                  <dt className="text-muted-foreground">Memory</dt>
                  <dd>
                    {usedMemories.length === 0 ? (
                      "None"
                    ) : (
                      <ul className="flex flex-col gap-0.5">
                        {usedMemories.map((store) => (
                          <li key={store.id}>
                            <Link
                              href={`/memory/${store.id}`}
                              className="hover:underline"
                            >
                              {MEMORY_SCOPE_LABEL[store.scope]}
                            </Link>
                            {store.scope === "custom" && (
                              <span className="text-muted-foreground">
                                {" "}
                                · {store.name}
                                {!store.isActive && " (inactive)"}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </dd>
                  <dt className="text-muted-foreground">Knowledge</dt>
                  <dd>
                    {knowledge.length === 0 ? (
                      "None"
                    ) : (
                      <ul className="flex flex-col gap-0.5">
                        {knowledge.map((collection) => (
                          <li key={collection.collectionId}>
                            <Link
                              href={`/knowledge/${collection.collectionId}`}
                              className="hover:underline"
                            >
                              {collection.name}
                            </Link>
                            <span className="text-muted-foreground">
                              {" "}
                              · {KNOWLEDGE_MODE_LABEL[collection.mode]}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </dd>
                  <dt className="text-muted-foreground">Schedules</dt>
                  <dd>
                    {agentSchedules.length === 0 ? (
                      "None"
                    ) : (
                      <ul className="flex flex-col gap-0.5">
                        {agentSchedules.map((schedule) => (
                          <li key={schedule.id}>
                            <Link
                              href={`/schedules/${schedule.id}`}
                              className="hover:underline"
                            >
                              {schedule.name}
                            </Link>
                            <span className="text-muted-foreground">
                              {" "}
                              · {describeTrigger(schedule)}
                              {!schedule.isActive &&
                                (schedule.pausedReason
                                  ? " (paused)"
                                  : " (inactive)")}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </dd>
                  <dt className="text-muted-foreground">System prompt</dt>
                  <dd>
                    <pre className="max-h-64 overflow-y-auto overflow-x-auto whitespace-pre-wrap rounded-lg border bg-muted/30 p-2 text-xs">
                      {agent.systemPrompt ?? "(no system prompt)"}
                    </pre>
                  </dd>
                </dl>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex flex-col gap-3">
                <div>
                  <p className="mb-1 text-sm font-medium">Skills</p>
                  <RefList
                    items={agent.skills}
                    emptyLabel="No skills assigned."
                  />
                </div>
                <div>
                  <p className="mb-1 text-sm font-medium">HTTP tools</p>
                  <RefList
                    items={agent.tools}
                    emptyLabel="No HTTP tools assigned."
                  />
                </div>
                <div>
                  <p className="mb-1 text-sm font-medium">Sub-agents</p>
                  <RefList
                    items={agent.subAgents}
                    emptyLabel="No sub-agents assigned."
                  />
                </div>
                <div>
                  <p className="mb-1 text-sm font-medium">MCP tools</p>
                  {agent.mcpTools.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No MCP tools assigned.
                    </p>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {agent.mcpTools.map((group) => (
                        <div key={group.serverId} className="text-sm">
                          <span className="font-medium">
                            {group.serverName}
                          </span>
                          {group.status === "inactive" && (
                            <span className="text-muted-foreground">
                              {" "}
                              (inactive)
                            </span>
                          )}
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            {group.tools.map((tool) => (
                              <Badge key={tool.name} variant="secondary">
                                {tool.name}
                                {tool.needsApproval && (
                                  <span title="Requires approval before running">
                                    · approval
                                  </span>
                                )}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="evaluation" keepMounted className="mt-3">
          <CriteriaPanel
            agentId={id}
            autoEvaluate={agent.autoEvaluate}
            recordTraffic={agent.recordTraffic}
            criteria={criteriaData.criteria}
            lastEvaluationError={criteriaData.lastEvaluationError}
            copySources={copySources}
          />
        </TabsContent>

        <TabsContent value="connect" className="mt-3">
          <AgentConnect slug={agent.slug} />
        </TabsContent>
      </AgentTabs>
    </div>
  );
}
