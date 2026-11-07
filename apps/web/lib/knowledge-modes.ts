import {
  ALWAYS_CONTEXT_SHARE,
  CHARS_PER_TOKEN,
  DEFAULT_CONTEXT_LIMIT,
  type KnowledgeDocumentStatus,
  type KnowledgeMode,
} from "@agentlathe/db/constants";

export const KNOWLEDGE_MODE_LABEL: Record<KnowledgeMode, string> = {
  search: "Search",
  always: "Always read",
};

export const KNOWLEDGE_MODE_DESCRIPTION: Record<KnowledgeMode, string> = {
  search: "Searched with the search_knowledge tool when the agent needs it.",
  always:
    "Read whole on every run. For short documents the agent must always keep in mind.",
};

export type KnowledgeLink = { collectionId: string; mode: KnowledgeMode };

export function alwaysReadUsage(
  links: KnowledgeLink[],
  charsOf: (collectionId: string) => number,
  contextLength: number | null,
): { tokens: number; budget: number; fits: boolean } {
  const chars = links
    .filter((link) => link.mode === "always")
    .reduce((sum, link) => sum + charsOf(link.collectionId), 0);
  const tokens = Math.ceil(chars / CHARS_PER_TOKEN);
  const budget = Math.floor(
    (contextLength ?? DEFAULT_CONTEXT_LIMIT) * ALWAYS_CONTEXT_SHARE,
  );
  return { tokens, budget, fits: tokens <= budget };
}

export const DOCUMENT_STATUS_LABEL: Record<KnowledgeDocumentStatus, string> = {
  pending: "waiting",
  processing: "processing",
  ready: "ready",
  failed: "failed",
};

export function documentStatusVariant(
  status: KnowledgeDocumentStatus,
): "default" | "secondary" | "destructive" {
  if (status === "ready") return "default";
  return status === "failed" ? "destructive" : "secondary";
}
