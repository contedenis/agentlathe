import { PROVIDER_BASE_URL } from "@agentlathe/runner";

const OPENROUTER_MODELS_URL = `${PROVIDER_BASE_URL}/models`;
const CACHE_TTL_MS = 60 * 60 * 1000;

export type ModelOption = {
  id: string;
  name: string;
  contextLength: number | null;
  promptPrice: number | null;
  completionPrice: number | null;
};

type OpenRouterModelsResponse = {
  data?: Array<{
    id: string;
    name?: string;
    context_length?: number;
    pricing?: { prompt?: string; completion?: string };
  }>;
};

function parsePrice(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

let cache: { expiresAt: number; models: ModelOption[] } | null = null;

async function fetchModels(): Promise<ModelOption[]> {
  // OpenRouter's /models is public, but OpenAI's and LiteLLM's require the key.
  const apiKey = process.env.PROVIDER_API_KEY;
  const res = await fetch(OPENROUTER_MODELS_URL, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  });
  if (!res.ok)
    throw new Error(`OpenRouter models request failed: ${res.status}`);
  const body = (await res.json()) as OpenRouterModelsResponse;
  return (body.data ?? []).map((model) => ({
    id: model.id,
    name: model.name ?? model.id,
    contextLength: model.context_length ?? null,
    promptPrice: parsePrice(model.pricing?.prompt),
    completionPrice: parsePrice(model.pricing?.completion),
  }));
}

export function estimateCostUsd(
  models: ModelOption[],
  modelId: string | null,
  inputTokens: number,
  outputTokens: number,
): number | null {
  if (!modelId) return null;
  const model = models.find((candidate) => candidate.id === modelId);
  if (!model || model.promptPrice === null || model.completionPrice === null)
    return null;
  return inputTokens * model.promptPrice + outputTokens * model.completionPrice;
}

export async function getOpenRouterModels(): Promise<ModelOption[]> {
  if (cache && cache.expiresAt >= Date.now()) return cache.models;
  try {
    cache = {
      expiresAt: Date.now() + CACHE_TTL_MS,
      models: await fetchModels(),
    };
    return cache.models;
  } catch {
    // Do not cache the failure; serve the stale cache if there is one.
    return cache?.models ?? [];
  }
}
