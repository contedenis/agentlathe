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
  "memory",
  "knowledge",
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

export const RUN_LABEL_MAX_LENGTH = 200;

export type RunWarning = { code: string; message: string };

export type MemorySeen = {
  storeId: string;
  partitionKey: string;
  revision: number;
};

export const MEMORY_SCOPES = ["agent", "agent_subject", "custom"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_ENTRY_OPS = [
  "add",
  "update",
  "delete",
  "compaction",
  "restore",
] as const;
export type MemoryEntryOp = (typeof MEMORY_ENTRY_OPS)[number];

export const MEMORY_AUTHORS = ["agent", "human", "compaction"] as const;
export type MemoryAuthor = (typeof MEMORY_AUTHORS)[number];

export const MEMORY_PROPOSAL_OPS = ["add", "update", "delete"] as const;
export const MEMORY_PROPOSAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
] as const;
export type MemoryProposalStatus = (typeof MEMORY_PROPOSAL_STATUSES)[number];

export const MEMORY_COMPACTION_STATUSES = [
  "running",
  "applied",
  "failed",
] as const;
export type MemoryCompactionStatus =
  (typeof MEMORY_COMPACTION_STATUSES)[number];

export const DEFAULT_MEMORY_CHAR_LIMIT = 8000;
export const MAX_MEMORY_CHAR_LIMIT = 20000;
export const MEMORY_ENTRY_MAX_LENGTH = 500;
export const COMPACTION_TRIGGER_SHARE = 0.9;
export const COMPACTION_TARGET_SHARE = 0.6;

export const DEFAULT_MEMORY_PURPOSES: Record<
  Exclude<MemoryScope, "custom">,
  string
> = {
  agent:
    'Things you learned about doing your job that hold for every conversation: procedures, conventions, decisions, and facts about the systems and tools you use (e.g. "Refunds over $500 go to the billing team", "The orders API returns 404 for archived orders; use the archive endpoint"). Never store anything about a specific person or customer, and nothing that only mattered in one conversation.',
  agent_subject:
    'Your own history with this subject in your job: open cases, commitments you made ("promised to follow up on ticket 123 on Friday"), what was tried and how it ended, and preferences that only matter for your task. General facts about the subject do not go here, and neither do procedures that apply to everyone.',
};

export const MEMORY_SHORT_ID_PREFIX: Record<MemoryScope, string> = {
  agent: "a",
  agent_subject: "s",
  custom: "c",
};

export type MemoryRunKeys = {
  agentId: string;
  subjectId: string | null;
  memoryKey: string | null;
};

export function memoryPartitionKey(
  scope: MemoryScope,
  { agentId, subjectId, memoryKey }: MemoryRunKeys,
): string | null {
  if (scope === "agent") return agentId;
  if (scope === "custom") return memoryKey;
  return subjectId;
}

export const KNOWLEDGE_DOCUMENT_STATUSES = [
  "pending",
  "processing",
  "ready",
  "failed",
] as const;
export type KnowledgeDocumentStatus =
  (typeof KNOWLEDGE_DOCUMENT_STATUSES)[number];

export const KNOWLEDGE_MEDIA_TYPES = [
  "application/pdf",
  "text/markdown",
  "text/plain",
] as const;
export type KnowledgeMediaType = (typeof KNOWLEDGE_MEDIA_TYPES)[number];

export const KNOWLEDGE_MODES = ["search", "always"] as const;
export type KnowledgeMode = (typeof KNOWLEDGE_MODES)[number];

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const CHUNK_SIZE = 800;
export const CHUNK_OVERLAP = 150;
export const SEARCH_RESULTS = 5;
export const ALWAYS_CONTEXT_SHARE = 0.25;
export const CHARS_PER_TOKEN = 4;
export const DEFAULT_CONTEXT_LIMIT = 128_000;
export const PROCESSING_ATTEMPTS = 3;
export const PROCESSING_STALE_MINUTES = 10;
export const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const PAGE_BREAK = "\f";

export const DEFAULT_AGENT_RUN_TTL_DAYS = 90;
export const MAX_AGENT_RUN_TTL_DAYS = 3650;
export const DEFAULT_TRANSCRIPT_TTL_DAYS = 14;

export const DEFAULT_TRACK_DASHBOARD_RUNS = true;
export const DEFAULT_TRACK_V1_RUNS = false;
export const DEFAULT_TRACK_MCP_RUNS = false;
export const DEFAULT_TRACK_SCHEDULE_RUNS = true;

// Operator-defined secrets. The app must never read this namespace for its own config.
export const SECRET_ENV_PREFIX = "AGENTLATHE_SECRET_";
