import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@agentlathe/runner", () => ({
  PROVIDER_BASE_URL: "https://openrouter.ai/api/v1",
}));

import { askJudge, decisionsUrl, judgeHost } from "./judge";

describe("decisionsUrl — the Decisions API sits next to the configured provider", () => {
  it("derives OpenRouter's alpha endpoint from its /api/v1 base", () => {
    expect(decisionsUrl("https://openrouter.ai/api/v1")).toBe(
      "https://openrouter.ai/api/alpha/decisions",
    );
  });

  it("tolerates a trailing slash", () => {
    expect(decisionsUrl("https://openrouter.ai/api/v1/")).toBe(
      "https://openrouter.ai/api/alpha/decisions",
    );
  });

  it("follows any other base the same way, with no host sniffing", () => {
    expect(decisionsUrl("http://127.0.0.1:4000/api/v1")).toBe(
      "http://127.0.0.1:4000/api/alpha/decisions",
    );
    expect(decisionsUrl("http://localhost:11434/v1")).toBe(
      "http://localhost:11434/alpha/decisions",
    );
  });
});

describe("askJudge — classifying what the Decisions API answers", () => {
  const fetchMock = vi.fn();
  const ask = () =>
    askJudge({
      model: "typesafe/jev-1.13",
      state: "USER: hi",
      questions: { pass_0: { instructions: "ok?" } },
    });
  const respond = (status: number, body: unknown) =>
    fetchMock.mockResolvedValue(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
      }),
    );
  const answered = (answers: Record<string, unknown>) => ({
    model: "typesafe/jev-1.13-20260917",
    answers,
    usage: { input_tokens: 468, output_tokens: 63, cost: 0.000019656 },
    id: "gen-dec-1",
    provider: "TypeSafe",
  });

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("PROVIDER_API_KEY", "test-key");
    vi.stubEnv("JUDGE_URL", "");
    vi.stubEnv("JUDGE_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returns the dated model and one probability per question", async () => {
    respond(200, answered({ pass_0: { type: "noul", noul: 0.01 } }));

    await expect(ask()).resolves.toEqual({
      tooLong: false,
      model: "typesafe/jev-1.13-20260917",
      answers: { pass_0: 0.01 },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(init.headers.Authorization).toBe("Bearer test-key");
    expect(JSON.parse(init.body)).toEqual({
      model: "typesafe/jev-1.13",
      state: "USER: hi",
      questions: { pass_0: { type: "noul", instructions: "ok?" } },
    });
  });

  it("a missing answer is an error", async () => {
    respond(200, answered({}));
    await expect(ask()).rejects.toThrow(
      "returned no answer for question pass_0",
    );
  });

  it.each([1.2, -0.1, null, "0.5"])(
    "a probability of %s is an error, not a verdict",
    async (noul) => {
      respond(200, answered({ pass_0: { type: "noul", noul } }));
      await expect(ask()).rejects.toThrow("invalid probability from judge");
    },
  );

  it("a 200 that is not JSON is an error", async () => {
    respond(200, "<html>");
    await expect(ask()).rejects.toThrow("not JSON");
  });

  it("max_tokens_exceeded is too long, not an error", async () => {
    respond(400, {
      error: {
        message: 'HTTP 400: {"detail":{"error_type":"max_tokens_exceeded"}}',
        code: 400,
      },
    });
    await expect(ask()).resolves.toEqual({ tooLong: true });
  });

  it("tolerates whitespace in the embedded error_type", async () => {
    respond(400, {
      error: {
        message: 'HTTP 400: {"detail": {"error_type" : "max_tokens_exceeded"}}',
        code: 400,
      },
    });
    await expect(ask()).resolves.toEqual({ tooLong: true });
  });

  it("a 400 that merely mentions max_tokens_exceeded elsewhere is an error", async () => {
    respond(400, {
      error: { message: "max_tokens_exceeded is not a valid model", code: 400 },
    });
    await expect(ask()).rejects.toThrow("HTTP 400");
  });

  it("a rejected key points at PROVIDER_API_KEY", async () => {
    respond(401, {
      error: { message: "Missing Authentication header", code: 401 },
    });
    await expect(ask()).rejects.toThrow(
      /Missing Authentication header.*PROVIDER_API_KEY/,
    );
  });

  it("a 404 says the provider does not serve the Decisions API and how to point elsewhere", async () => {
    respond(404, "Not Found");
    await expect(ask()).rejects.toThrow(
      "the configured provider does not serve the Decisions API; set JUDGE_URL and JUDGE_API_KEY to a Jev endpoint",
    );
  });

  it("an unknown model points at the judge model setting", async () => {
    respond(400, {
      error: { message: "Model typesafe/jev-9.99 does not exist", code: 400 },
    });
    await expect(ask()).rejects.toThrow(
      "Model typesafe/jev-9.99 does not exist; check the judge model in Settings",
    );
  });

  it.each([429, 502])(
    "HTTP %s is an error carrying the status and message",
    async (status) => {
      respond(status, { error: { message: "slow down", code: status } });
      await expect(ask()).rejects.toThrow(`HTTP ${status}: slow down`);
    },
  );

  it("a timeout and a network failure are errors that say which", async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error("aborted"), { name: "TimeoutError" }),
    );
    await expect(ask()).rejects.toThrow("did not answer within 20s");

    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(ask()).rejects.toThrow(
      "could not reach the Decisions API: fetch failed",
    );
  });

  it("refuses to call without PROVIDER_API_KEY", async () => {
    vi.stubEnv("PROVIDER_API_KEY", "");
    await expect(ask()).rejects.toThrow("PROVIDER_API_KEY is not set");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("askJudge — a judge endpoint of its own", () => {
  const fetchMock = vi.fn();
  const ask = () =>
    askJudge({
      model: "jev-latest",
      state: "USER: hi",
      questions: { pass_0: { instructions: "ok?" } },
    });
  const respond = (status: number, body: unknown) =>
    fetchMock.mockResolvedValue(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
      }),
    );

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("PROVIDER_API_KEY", "provider-key");
    vi.stubEnv("JUDGE_URL", "");
    vi.stubEnv("JUDGE_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("JUDGE_URL and JUDGE_API_KEY replace the provider's endpoint and key", async () => {
    vi.stubEnv("JUDGE_URL", "https://api.typesafe.ai/v1/systemone");
    vi.stubEnv("JUDGE_API_KEY", "judge-key");
    respond(200, {
      model: "jev-1.13.0",
      answers: { pass_0: { type: "noul", noul: 0.9 } },
      usage: { input_tokens: 120, output_tokens: 20 },
    });

    await expect(ask()).resolves.toEqual({
      tooLong: false,
      model: "jev-1.13.0",
      answers: { pass_0: 0.9 },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.headers.Authorization).toBe("Bearer judge-key");
  });

  it("never sends the provider key to a JUDGE_URL without its own key", async () => {
    vi.stubEnv("JUDGE_URL", "https://api.typesafe.ai/v1/systemone");
    await expect(ask()).rejects.toThrow("JUDGE_API_KEY is not set");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("JUDGE_API_KEY alone keeps the provider's endpoint", async () => {
    vi.stubEnv("JUDGE_API_KEY", "judge-key");
    respond(200, {
      model: "typesafe/jev-1.13-20260917",
      answers: { pass_0: { type: "noul", noul: 0.9 } },
    });

    await ask();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(init.headers.Authorization).toBe("Bearer judge-key");
  });

  it("TypeSafe's own too-long body is too long, not an error", async () => {
    vi.stubEnv("JUDGE_URL", "https://api.typesafe.ai/v1/systemone");
    vi.stubEnv("JUDGE_API_KEY", "judge-key");
    respond(400, { detail: { error_type: "max_tokens_exceeded" } });
    await expect(ask()).resolves.toEqual({ tooLong: true });
  });

  it("errors name JUDGE_URL and JUDGE_API_KEY instead of the provider's", async () => {
    vi.stubEnv("JUDGE_URL", "https://judge.example.com/v1/systemone");
    vi.stubEnv("JUDGE_API_KEY", "judge-key");

    respond(404, "Not Found");
    await expect(ask()).rejects.toThrow(
      "JUDGE_URL does not serve the Decisions API (HTTP 404 from judge.example.com)",
    );

    respond(401, { error: { message: "bad key" } });
    await expect(ask()).rejects.toThrow(/bad key.*check JUDGE_API_KEY/);
  });
});

describe("judgeHost — what Settings shows", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is the provider's host by default and JUDGE_URL's when set", () => {
    vi.stubEnv("JUDGE_URL", "");
    expect(judgeHost()).toBe("openrouter.ai");
    vi.stubEnv("JUDGE_URL", "https://api.typesafe.ai/v1/systemone");
    expect(judgeHost()).toBe("api.typesafe.ai");
  });

  it("falls back to the raw value when JUDGE_URL is not a URL", () => {
    vi.stubEnv("JUDGE_URL", "not a url");
    expect(judgeHost()).toBe("not a url");
  });
});
