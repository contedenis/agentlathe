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

export const RESERVED_TOOL_NAMES = [
  "load_skill",
  "memory_add",
  "memory_update",
  "memory_delete",
  "search_knowledge",
] as const;

export const TOOL_NAME_MAX_LENGTH = 64;

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function capToolName(name: string): string {
  if (name.length <= TOOL_NAME_MAX_LENGTH) return name;
  const digest = shortHash(name);
  return `${name.slice(0, TOOL_NAME_MAX_LENGTH - digest.length - 1)}_${digest}`;
}

export function httpToolName(name: string): string {
  return capToolName(slug(name) || "tool");
}

export function mcpToolName(serverName: string, toolName: string): string {
  return capToolName(`${slug(serverName)}__${toolName}`);
}

export function subAgentToolName(agentSlugValue: string): string {
  return capToolName(`subagent_${slug(agentSlugValue)}`);
}

export function agentAskToolName(agentSlugValue: string): string {
  const base = slug(agentSlugValue).toLowerCase().slice(0, 50);
  return base ? `ask_${base}` : "ask_agent";
}
