export function slug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export const AGENT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
export const AGENT_SLUG_MAX_LENGTH = 64;

export function agentSlug(name: string): string {
  const cleaned = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, AGENT_SLUG_MAX_LENGTH)
    .replace(/[._-]+$/g, "");
  return cleaned || "agent";
}

export function httpToolName(name: string): string {
  return slug(name) || "tool";
}

export function mcpToolName(serverName: string, toolName: string): string {
  return `${slug(serverName)}__${toolName}`;
}

export function subAgentToolName(agentSlugValue: string): string {
  return `subagent_${slug(agentSlugValue)}`;
}

export function agentAskToolName(agentSlugValue: string): string {
  const base = slug(agentSlugValue).toLowerCase().slice(0, 50);
  return base ? `ask_${base}` : "ask_agent";
}
