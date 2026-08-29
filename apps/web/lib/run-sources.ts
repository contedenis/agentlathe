import {
  AGENT_RUN_SOURCES,
  type AgentRunSource,
} from "@agentlathe/db/constants";

export const SOURCE_ORDER: AgentRunSource[] = [...AGENT_RUN_SOURCES];

export const SOURCE_LABEL: Record<AgentRunSource, string> = {
  dashboard: "Playground",
  v1: "API /v1",
  mcp: "MCP",
};

export const SOURCE_COLOR: Record<string, string> = {
  dashboard: "var(--chart-1)",
  v1: "var(--chart-2)",
  mcp: "var(--chart-3)",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABEL[source as AgentRunSource] ?? source;
}
