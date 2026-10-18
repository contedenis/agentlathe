export const AGENT_RUN_SOURCES = [
  "dashboard",
  "v1",
  "mcp",
  "schedule",
] as const;
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

export const RUN_EVALUATION_STATUSES = [
  "pass",
  "fail",
  "needs_review",
  "not_applicable",
  "skipped",
  "error",
] as const;
export type RunEvaluationStatus = (typeof RUN_EVALUATION_STATUSES)[number];

export const RUN_EVALUATION_SKIP_REASONS = [
  "too_long",
  "awaiting_approval",
] as const;
export type RunEvaluationSkipReason =
  (typeof RUN_EVALUATION_SKIP_REASONS)[number];

export const REVIEWED_VERDICTS = ["pass", "fail"] as const;
export type ReviewedVerdict = (typeof REVIEWED_VERDICTS)[number];

export const DEFAULT_CRITERION_FAIL_BELOW = 0.2;
export const DEFAULT_CRITERION_PASS_ABOVE = 0.8;
export const CRITERION_DESCRIPTION_MAX_LENGTH = 2000;
export const DEFAULT_JUDGE_MODEL = "typesafe/jev-1.13";

export const SCHEDULE_FREQUENCIES = [
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "monthly",
] as const;
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];

export const SCHEDULE_OCCURRENCE_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "skipped_overlap",
  "skipped_missed",
  "blocked_preflight",
  "interrupted",
] as const;
export type ScheduleOccurrenceStatus =
  (typeof SCHEDULE_OCCURRENCE_STATUSES)[number];

export const DEFAULT_AGENT_RUN_TTL_DAYS = 90;
export const MAX_AGENT_RUN_TTL_DAYS = 3650;
export const DEFAULT_TRANSCRIPT_TTL_DAYS = 14;

export const DEFAULT_TRACK_DASHBOARD_RUNS = true;
export const DEFAULT_TRACK_V1_RUNS = false;
export const DEFAULT_TRACK_MCP_RUNS = false;
export const DEFAULT_TRACK_SCHEDULE_RUNS = true;

// Operator-defined secrets. The app must never read this namespace for its own config.
export const SECRET_ENV_PREFIX = "AGENTLATHE_SECRET_";
