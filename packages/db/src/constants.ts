export const AGENT_RUN_SOURCES = ["dashboard", "v1", "mcp"] as const;
export type AgentRunSource = (typeof AGENT_RUN_SOURCES)[number];

export const AGENT_RUN_CALL_KINDS = [
  "tool",
  "mcp",
  "sub_agent",
  "skill",
] as const;
export type AgentRunCallKind = (typeof AGENT_RUN_CALL_KINDS)[number];

export const FIX_DRAFT_CATEGORIES = [
  "prompt",
  "tool_definition",
  "tool_policy",
  "missing_tool",
  "model",
  "other",
] as const;

export const FIX_DRAFT_STATUSES = ["open", "dismissed", "applied"] as const;

export const DEFAULT_AGENT_RUN_TTL_DAYS = 90;
export const MAX_AGENT_RUN_TTL_DAYS = 3650;
export const DEFAULT_TRANSCRIPT_TTL_DAYS = 14;

export const DEFAULT_TRACK_DASHBOARD_RUNS = true;
export const DEFAULT_TRACK_V1_RUNS = false;
export const DEFAULT_TRACK_MCP_RUNS = false;

// Operator-defined secrets. The app must never read this namespace for its own config.
export const SECRET_ENV_PREFIX = "AGENTLATHE_SECRET_";
