import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetContextLimitCache,
  buildAuth,
  estimateTokens,
  getContextLimit,
} from "./helpers";

describe("buildAuth", () => {
  it("returns {} for null", () => {
    expect(buildAuth(null)).toEqual({});
  });

  it("returns {} for undefined", () => {
    expect(buildAuth(undefined)).toEqual({});
  });

  it("returns {} for a string", () => {
    expect(buildAuth("not an object")).toEqual({});
  });

  it("returns {} for a number", () => {
    expect(buildAuth(42)).toEqual({});
  });

  it("returns {} for an object without headers", () => {
    expect(buildAuth({ foo: "bar" })).toEqual({});
  });

  it("returns {} when headers is not an object", () => {
    expect(buildAuth({ headers: "not an object" })).toEqual({});
  });

  it("returns the headers for a valid auth_config", () => {
    expect(buildAuth({ headers: { Authorization: "Bearer abc" } })).toEqual({
      Authorization: "Bearer abc",
    });
  });

  it("resolves an AGENTLATHE_SECRET_ value from the environment", () => {
    vi.stubEnv("AGENTLATHE_SECRET_TEST_TOKEN", "Bearer resolved");
    expect(
      buildAuth({
        headers: {
          Authorization: "AGENTLATHE_SECRET_TEST_TOKEN",
          "x-static": "literal",
        },
      }),
    ).toEqual({ Authorization: "Bearer resolved", "x-static": "literal" });
    vi.unstubAllEnvs();
  });

  it("throws when a referenced env var is not set, naming header and var", () => {
    expect(() =>
      buildAuth({ headers: { Authorization: "AGENTLATHE_SECRET_MISSING" } }),
    ).toThrowError(
      'Auth header "Authorization" references the env var AGENTLATHE_SECRET_MISSING, which is not set.',
    );
  });

  it("treats an empty env var as unset", () => {
    vi.stubEnv("AGENTLATHE_SECRET_EMPTY", "");
    expect(() =>
      buildAuth({ headers: { Authorization: "AGENTLATHE_SECRET_EMPTY" } }),
    ).toThrowError(/AGENTLATHE_SECRET_EMPTY, which is not set/);
    vi.unstubAllEnvs();
  });
});

describe("estimateTokens", () => {
  it("estimates ceil(length/4) characters of the JSON-stringified input", () => {
    const messages = [{ role: "user", content: "hello" }];
    const expected = Math.ceil(JSON.stringify(messages).length / 4);
    expect(estimateTokens(messages)).toBe(expected);
  });

  it("rounds up (never underestimates)", () => {
    expect(Number.isInteger(estimateTokens([{ a: 1 }]))).toBe(true);
    expect(estimateTokens("x")).toBeGreaterThanOrEqual(
      JSON.stringify("x").length / 4,
    );
  });

  it("scales with input size", () => {
    const small = estimateTokens([{ role: "user", content: "hi" }]);
    const large = estimateTokens([{ role: "user", content: "hi".repeat(100) }]);
    expect(large).toBeGreaterThan(small);
  });
});

describe("getContextLimit", () => {
  beforeEach(() => {
    __resetContextLimitCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetContextLimitCache();
  });

  const okResponse = (body: unknown) =>
    ({ ok: true, json: async () => body }) as Response;

  it("sends the provider key on the /models request, and no auth when unset", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    vi.stubEnv("PROVIDER_API_KEY", "sk-test");
    await getContextLimit("any/model");
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({
      Authorization: "Bearer sk-test",
    });

    __resetContextLimitCache();
    vi.stubEnv("PROVIDER_API_KEY", "");
    await getContextLimit("any/model");
    expect(fetchMock.mock.calls[1][1]?.headers).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it("returns the context_length of a known model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        data: [
          { id: "anthropic/claude-opus-4.8", context_length: 200_000 },
          { id: "openai/gpt-5", context_length: 400_000 },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getContextLimit("anthropic/claude-opus-4.8")).resolves.toBe(
      200_000,
    );
  });

  it("falls back to 128_000 for a model absent from the catalog", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        okResponse({ data: [{ id: "openai/gpt-5", context_length: 400_000 }] }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getContextLimit("unknown/model")).resolves.toBe(128_000);
  });

  it("caches: a second call does not re-invoke fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        data: [{ id: "anthropic/claude-opus-4.8", context_length: 200_000 }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getContextLimit("anthropic/claude-opus-4.8");
    await getContextLimit("anthropic/claude-opus-4.8");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to 128_000 when fetch rejects", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getContextLimit("anthropic/claude-opus-4.8")).resolves.toBe(
      128_000,
    );
  });

  it("passes an AbortSignal (its own short timeout) to fetch", async () => {
    let capturedSignal: unknown;
    const fetchMock = vi.fn().mockImplementation((_url, opts) => {
      capturedSignal = (opts as { signal?: unknown } | undefined)?.signal;
      return Promise.resolve(
        okResponse({
          data: [{ id: "anthropic/claude-opus-4.8", context_length: 200_000 }],
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await getContextLimit("anthropic/claude-opus-4.8");

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to 128_000 on an HTTP error response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500 } as Response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(getContextLimit("anthropic/claude-opus-4.8")).resolves.toBe(
      128_000,
    );
  });

  it("a failed fetch is NOT cached: it retries after the 60s cooldown and caches the success", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const fail = vi.fn().mockRejectedValue(new Error("network down"));
      vi.stubGlobal("fetch", fail);

      await expect(getContextLimit("anthropic/claude-opus-4.8")).resolves.toBe(
        128_000,
      );
      expect(fail).toHaveBeenCalledTimes(1);

      vi.setSystemTime(30_000);
      await expect(getContextLimit("anthropic/claude-opus-4.8")).resolves.toBe(
        128_000,
      );
      expect(fail).toHaveBeenCalledTimes(1);

      vi.setSystemTime(61_000);
      const ok = vi.fn().mockResolvedValue(
        okResponse({
          data: [{ id: "anthropic/claude-opus-4.8", context_length: 200_000 }],
        }),
      );
      vi.stubGlobal("fetch", ok);

      await expect(getContextLimit("anthropic/claude-opus-4.8")).resolves.toBe(
        200_000,
      );
      expect(ok).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
