import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Module = typeof import("./openrouter-models");

async function freshModule(): Promise<Module> {
  vi.resetModules();
  return import("./openrouter-models");
}

function okOnce(payload: unknown) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getOpenRouterModels — shaping the provider payload", () => {
  it("maps ids, names, context length and prices", async () => {
    vi.stubGlobal(
      "fetch",
      okOnce({
        data: [
          {
            id: "openai/gpt-4o",
            name: "GPT-4o",
            context_length: 128000,
            pricing: { prompt: "0.0000025", completion: "0.00001" },
          },
        ],
      }),
    );
    const { getOpenRouterModels } = await freshModule();

    expect(await getOpenRouterModels()).toEqual([
      {
        id: "openai/gpt-4o",
        name: "GPT-4o",
        contextLength: 128000,
        promptPrice: 0.0000025,
        completionPrice: 0.00001,
      },
    ]);
  });

  it("falls back to the id when the model has no name, and nulls a missing context length", async () => {
    vi.stubGlobal("fetch", okOnce({ data: [{ id: "some/model" }] }));
    const { getOpenRouterModels } = await freshModule();

    expect(await getOpenRouterModels()).toEqual([
      {
        id: "some/model",
        name: "some/model",
        contextLength: null,
        promptPrice: null,
        completionPrice: null,
      },
    ]);
  });

  it("nulls a price that is not a finite non-negative number", async () => {
    vi.stubGlobal(
      "fetch",
      okOnce({
        data: [
          {
            id: "weird/model",
            pricing: { prompt: "not-a-number", completion: "-1" },
          },
        ],
      }),
    );
    const { getOpenRouterModels } = await freshModule();

    const [model] = await getOpenRouterModels();
    expect(model.promptPrice).toBeNull();
    expect(model.completionPrice).toBeNull();
  });

  it("treats a missing data array as no models", async () => {
    vi.stubGlobal("fetch", okOnce({}));
    const { getOpenRouterModels } = await freshModule();

    expect(await getOpenRouterModels()).toEqual([]);
  });
});

describe("getOpenRouterModels — caching, and what a failure must not do", () => {
  it("serves the cache instead of fetching again inside the TTL", async () => {
    const fetchMock = okOnce({ data: [{ id: "a/b" }] });
    vi.stubGlobal("fetch", fetchMock);
    const { getOpenRouterModels } = await freshModule();

    await getOpenRouterModels();
    await getOpenRouterModels();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns no models when the first call fails and there is nothing cached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { getOpenRouterModels } = await freshModule();

    expect(await getOpenRouterModels()).toEqual([]);
  });

  it("returns no models when the provider answers a non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 503 })),
    );
    const { getOpenRouterModels } = await freshModule();

    expect(await getOpenRouterModels()).toEqual([]);
  });

  it("serves the stale cache on failure and retries on the next call", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "a/b" }] }), {
          status: 200,
        }),
      )
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "c/d" }] }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const { getOpenRouterModels } = await freshModule();

    expect((await getOpenRouterModels())[0].id).toBe("a/b");

    vi.advanceTimersByTime(61 * 60 * 1000);
    expect((await getOpenRouterModels())[0].id).toBe("a/b");

    expect((await getOpenRouterModels())[0].id).toBe("c/d");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});

describe("estimateCostUsd", () => {
  const models = [
    {
      id: "openai/gpt-4o",
      name: "GPT-4o",
      contextLength: 128000,
      promptPrice: 0.001,
      completionPrice: 0.002,
    },
    {
      id: "free/model",
      name: "Free",
      contextLength: null,
      promptPrice: null,
      completionPrice: null,
    },
  ];

  it("multiplies each token count by its own price", async () => {
    const { estimateCostUsd } = await freshModule();

    expect(estimateCostUsd(models, "openai/gpt-4o", 1000, 500)).toBeCloseTo(2);
  });

  it("returns null without a model id, for an unknown model, or without prices", async () => {
    const { estimateCostUsd } = await freshModule();

    expect(estimateCostUsd(models, null, 10, 10)).toBeNull();
    expect(estimateCostUsd(models, "nobody/knows", 10, 10)).toBeNull();
    expect(estimateCostUsd(models, "free/model", 10, 10)).toBeNull();
  });

  it("is zero, not null, when the run used no tokens", async () => {
    const { estimateCostUsd } = await freshModule();

    expect(estimateCostUsd(models, "openai/gpt-4o", 0, 0)).toBe(0);
  });
});

describe("getOpenRouterModels — provider auth", () => {
  it("sends the provider key when set, and no auth header when unset", async () => {
    vi.stubEnv("PROVIDER_API_KEY", "sk-test");
    const withKey = okOnce({ data: [] });
    vi.stubGlobal("fetch", withKey);
    const { getOpenRouterModels } = await freshModule();
    await getOpenRouterModels();
    expect(withKey.mock.calls[0][1]?.headers).toEqual({
      Authorization: "Bearer sk-test",
    });

    vi.stubEnv("PROVIDER_API_KEY", "");
    const withoutKey = okOnce({ data: [] });
    vi.stubGlobal("fetch", withoutKey);
    const fresh = await freshModule();
    await fresh.getOpenRouterModels();
    expect(withoutKey.mock.calls[0][1]?.headers).toBeUndefined();
    vi.unstubAllEnvs();
  });
});
