import { SECRET_ENV_PREFIX } from "@agentlathe/db";
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
const DEFAULT_CONTEXT_LIMIT = 128_000;

interface OpenRouterModelsResponse {
  data?: Array<{ id: string; context_length?: number }>;
}

// A failed fetch is NOT cached: 60s cooldown, then retry.
let modelLimitsCache: Promise<Record<string, number>> | null = null;
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

export async function getContextLimit(model: string): Promise<number> {
  if (!modelLimitsCache && Date.now() >= retryAfter) {
    modelLimitsCache = loadOpenRouterModelLimits().catch(() => {
      modelLimitsCache = null;
      retryAfter = Date.now() + 60_000;
      return {};
    });
  }
  const limits = (await modelLimitsCache) ?? {};
  return limits[model] ?? DEFAULT_CONTEXT_LIMIT;
}

export function __resetContextLimitCache(): void {
  modelLimitsCache = null;
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
    finalName = `${name}_${n}`;
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
