import type { UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./memory")>()),
  loadMemory: vi.fn(async () => ({ stores: [], seen: [], warnings: [] })),
}));
vi.mock("./loaders", () => ({
  loadAgentConfig: vi.fn(),
  loadKnowledgeCollections: vi.fn(async () => []),
  loadSkills: vi.fn(async () => []),
}));
vi.mock("./tools", () => ({ buildTools: vi.fn() }));
vi.mock("./helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./helpers")>();
  return {
    ...actual,
    buildProvider: vi.fn(),
    getContextLimit: vi.fn(async () => 128_000),
  };
});

import { toOpenAIChatCompletionStream } from "@agentlathe/openai-server";
import { generateWithApprovals } from "./generate-with-approvals";
import { buildProvider, runTimeout } from "./helpers";
import type { AgentRow } from "./loaders";
import { buildAgentRuntime } from "./runtime";
import { streamAgentForUI } from "./stream-ui";
import { buildTools } from "./tools";

const agent = {
  id: "agent-1",
  model: "openrouter/model",
  systemPrompt: "",
  maxSteps: 5,
} as AgentRow;

const hangUntilAborted = ({ abortSignal }: { abortSignal?: AbortSignal }) =>
  new Promise<never>((_, reject) => {
    if (abortSignal?.aborted) reject(abortSignal.reason);
    abortSignal?.addEventListener("abort", () => reject(abortSignal.reason), {
      once: true,
    });
  });

let toolsCleanup: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("RUN_TIMEOUT_SECONDS", "0.05");
  toolsCleanup = vi.fn(async () => {});
  vi.mocked(buildTools).mockResolvedValue({
    tools: {},
    approvalToolNames: new Set(),
    toolKinds: new Map(),
    mcpFailures: [],
    cleanup: toolsCleanup,
  });
  vi.mocked(buildProvider).mockReturnValue(
    new MockLanguageModelV4({
      doGenerate: hangUntilAborted as never,
      doStream: hangUntilAborted as never,
    }) as never,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runTimeout", () => {
  it("defaults to 30 minutes when unset or not a positive number", () => {
    for (const value of ["", "abc", "0", "-5"]) {
      vi.stubEnv("RUN_TIMEOUT_SECONDS", value);
      expect(runTimeout()).toEqual({ totalMs: 30 * 60 * 1000 });
    }
  });

  it("always yields whole milliseconds a timer accepts", () => {
    vi.stubEnv("RUN_TIMEOUT_SECONDS", "1.0005");
    expect(runTimeout()).toEqual({ totalMs: 1001 });
    vi.stubEnv("RUN_TIMEOUT_SECONDS", "0.0001");
    expect(runTimeout()).toEqual({ totalMs: 1 });
    vi.stubEnv("RUN_TIMEOUT_SECONDS", "5000000000");
    expect(() => AbortSignal.timeout(runTimeout().totalMs)).not.toThrow();
    expect(runTimeout()).toEqual({ totalMs: 2 ** 31 - 1 });
  });

  it("reads RUN_TIMEOUT_SECONDS", () => {
    vi.stubEnv("RUN_TIMEOUT_SECONDS", "90");
    expect(runTimeout()).toEqual({ totalMs: 90_000 });
  });
});

describe("a run whose provider never answers, against the real SDK", () => {
  it("generate: fails with a timeout instead of hanging, and still reports stats", async () => {
    const onStats = vi.fn();

    await expect(
      generateWithApprovals(agent, "hello", { onStats }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(onStats).toHaveBeenCalledTimes(1);
    expect(toolsCleanup).toHaveBeenCalledTimes(1);
  });

  it("stream (/v1): the SSE ends on an error frame and reports the timeout", async () => {
    const { agent: runtime } = await buildAgentRuntime(agent);
    const result = await runtime.stream({
      prompt: "hello",
      timeout: runTimeout(),
    });
    const onDone = vi.fn();

    const body = await toOpenAIChatCompletionStream(
      result.fullStream,
      "agent",
      { id: "x", created: 0 },
      onDone,
    ).text();

    expect(body).toContain("api_error");
    expect(body).not.toContain("[DONE]");
    expect(onDone).toHaveBeenCalledWith({
      errored: true,
      error: expect.objectContaining({
        message: "The run exceeded its time limit.",
      }),
    });
  });

  it("Playground: the turn ends and is recorded with the timeout as its error", async () => {
    const onRunEnd = vi.fn(async () => "run-1");
    const userMessage: UIMessage = {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    };

    const response = await streamAgentForUI(agent, [userMessage], { onRunEnd });
    const body = await response.text();

    expect(body).toContain("The run exceeded its time limit.");

    await vi.waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));
    expect(onRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ name: "TimeoutError" }),
      }),
    );
  });
});
