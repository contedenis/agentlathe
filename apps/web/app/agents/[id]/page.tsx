import Link from "next/link";
import { notFound } from "next/navigation";
import { ActiveBadge } from "@/components/active-badge";
import { AgentPlayground } from "@/components/agent-playground";
import { AgentWarningsBanner } from "@/components/agent-warnings-banner";
import { BreadcrumbTitle } from "@/components/breadcrumb-title";
import { CriteriaPanel } from "@/components/criteria-panel";
import { DeleteResourceButton } from "@/components/delete-resource-button";
import { PageHeader } from "@/components/page-header";
import { ToggleActiveButton } from "@/components/toggle-active-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  getAgentCriteria,
  getAgentDetail,
  getCriteriaCopySources,
} from "@/lib/queries";
import { listAgentSchedules } from "@/lib/queries-schedules";
import { describeTrigger } from "@/lib/scheduler/calendar";

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

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [agent, criteriaData, copySources, agentSchedules] = await Promise.all([
    getAgentDetail(id),
    getAgentCriteria(id),
    getCriteriaCopySources(id),
    listAgentSchedules(id),
  ]);
  if (!agent) notFound();

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

      <div className="flex gap-2">
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link href={`/agents/${id}/edit`} />}
        >
          Edit
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
      </div>

      <div className="flex flex-col gap-4 lg:h-[75vh] lg:flex-row">
        <div className="flex flex-col gap-3 lg:w-96 lg:shrink-0 lg:overflow-y-auto">
          <Tabs defaultValue="resumen">
            <TabsList className="w-full">
              <TabsTrigger value="resumen">Summary</TabsTrigger>
              <TabsTrigger value="tools">Tools</TabsTrigger>
              <TabsTrigger value="evaluation">Evaluation</TabsTrigger>
            </TabsList>

            <TabsContent value="resumen" className="mt-3">
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
            </TabsContent>

            <TabsContent value="tools" className="mt-3">
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
            </TabsContent>

            <TabsContent value="evaluation" className="mt-3">
              <CriteriaPanel
                agentId={id}
                autoEvaluate={agent.autoEvaluate}
                recordTraffic={agent.recordTraffic}
                criteria={criteriaData.criteria}
                lastEvaluationError={criteriaData.lastEvaluationError}
                copySources={copySources}
              />
            </TabsContent>
          </Tabs>
        </div>

        <div className="h-[32rem] min-w-0 flex-1 lg:h-full">
          <AgentPlayground agentId={id} />
        </div>
      </div>
    </div>
  );
}
