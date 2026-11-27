import {
  capToolName,
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_EMBEDDING_MODEL,
  SECRET_ENV_PREFIX,
} from "@agentlathe/db";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ToolSet } from "ai";

export const PROVIDER_BASE_URL =
  process.env.PROVIDER_BASE_URL ?? "https://openrouter.ai/api/v1";

const openrouter = createOpenAICompatible({
  name: "openrouter",
  apiKey: process.env.PROVIDER_API_KEY,
  baseURL: PROVIDER_BASE_URL,
});

export function buildProvider(model: string) {
  return openrouter(model);
}

const DEFAULT_RUN_TIMEOUT_SECONDS = 30 * 60;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export function runTimeout(): { totalMs: number } {
  const seconds = Number(process.env.RUN_TIMEOUT_SECONDS);
  const ms =
    (Number.isFinite(seconds) && seconds > 0
      ? seconds
      : DEFAULT_RUN_TIMEOUT_SECONDS) * 1000;
  return { totalMs: Math.min(Math.max(Math.round(ms), 1), MAX_TIMEOUT_MS) };
}

export function embeddingModelId(): string {
  return process.env.EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
}

export function buildEmbeddingModel() {
  return openrouter.embeddingModel(embeddingModelId());
}

export function buildAuth(authConfig: unknown): Record<string, string> {
  if (!authConfig || typeof authConfig !== "object") return {};
  const headers = (authConfig as { headers?: unknown }).headers;
  if (!headers || typeof headers !== "object") return {};
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(
    headers as Record<string, string>,
  )) {
    if (typeof value === "string" && value.startsWith(SECRET_ENV_PREFIX)) {
      // "" counts as unset: compose's ${VAR:-} pattern injects empty strings.
      const secret = process.env[value];
      if (!secret)
        throw new Error(
          `Auth header "${name}" references the env var ${value}, which is not set.`,
        );
      resolved[name] = secret;
    } else {
      resolved[name] = value;
    }
  }
  return resolved;
}

const OPENROUTER_MODELS_URL = `${PROVIDER_BASE_URL}/models`;

interface OpenRouterModelsResponse {
  data?: Array<{ id: string; context_length?: number }>;
}

// A failed fetch is NOT cached: 60s cooldown, then retry.
const MODEL_LIMITS_TTL_MS = 60 * 60 * 1000;
let modelLimits: Record<string, number> | null = null;
let modelLimitsRefresh: Promise<void> | null = null;
let refreshAfter = 0;
let retryAfter = 0;

async function loadOpenRouterModelLimits(): Promise<Record<string, number>> {
  // OpenRouter's /models is public, but OpenAI's and LiteLLM's require the key.
  const apiKey = process.env.PROVIDER_API_KEY;
  const res = await fetch(OPENROUTER_MODELS_URL, {
    signal: AbortSignal.timeout(5_000),
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  });
  if (!res.ok)
    throw new Error(`OpenRouter models request failed: ${res.status}`);
  const body = (await res.json()) as OpenRouterModelsResponse;
  const limits: Record<string, number> = {};
  for (const model of body.data ?? []) {
    if (typeof model.context_length === "number")
      limits[model.id] = model.context_length;
  }
  return limits;
}

export function fallbackContextLimit(): number {
  const tokens = Number(process.env.CONTEXT_LIMIT_FALLBACK);
  return Number.isInteger(tokens) && tokens > 0
    ? tokens
    : DEFAULT_CONTEXT_LIMIT;
}

export async function getContextLimit(model: string): Promise<number> {
  const now = Date.now();
  if (
    !modelLimitsRefresh &&
    (!modelLimits || now >= refreshAfter) &&
    now >= retryAfter
  ) {
    modelLimitsRefresh = loadOpenRouterModelLimits()
      .then((limits) => {
        modelLimits = limits;
        refreshAfter = Date.now() + MODEL_LIMITS_TTL_MS;
      })
      .catch(() => {
        retryAfter = Date.now() + 60_000;
      })
      .finally(() => {
        modelLimitsRefresh = null;
      });
  }
  if (!modelLimits) await modelLimitsRefresh;
  return modelLimits?.[model] ?? fallbackContextLimit();
}

export function __resetContextLimitCache(): void {
  modelLimits = null;
  modelLimitsRefresh = null;
  refreshAfter = 0;
  retryAfter = 0;
}

export function estimateTokens(messages: unknown): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

export function addTool(
  target: ToolSet,
  name: string,
  toolDef: ToolSet[string],
): string {
  let finalName = name;
  let n = 2;
  while (finalName in target) {
    finalName = capToolName(`${name}_${n}`);
    n += 1;
  }
  if (finalName !== name)
    console.warn(`Tool name collision: "${name}" renamed to "${finalName}".`);
  target[finalName] = toolDef;
  return finalName;
}

// Approval must follow the FINAL name, or a collision rename drops the gate.
export function addToolWithApproval(
  target: ToolSet,
  name: string,
  toolDef: ToolSet[string],
  approvedNames: Set<string>,
  approvalTarget: Set<string>,
): string {
  const finalName = addTool(target, name, toolDef);
  if (approvedNames.has(name)) approvalTarget.add(finalName);
  return finalName;
}
