import { isToolUIPart, tool, type UIMessage } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("./loaders", () => ({
  loadAgentConfig: vi.fn(),
  loadSkills: vi.fn(async () => []),
}));
vi.mock("./tools", () => ({ buildTools: vi.fn() }));
vi.mock("./helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./helpers")>();
  return { ...actual, buildProvider: vi.fn() };
});

import { buildProvider } from "./helpers";
import type { AgentRow } from "./loaders";
import { streamAgentForUI } from "./stream-ui";
import { buildTools } from "./tools";

const agent = {
  id: "agent-1",
  model: "openrouter/model",
  systemPrompt: "",
  maxSteps: 5,
} as AgentRow;

const usage = {
  inputTokens: {
    total: 5,
    noCache: 5,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

const toolCallTurn = (input: unknown) => ({
  stream: convertArrayToReadableStream([
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "lookup",
      input: JSON.stringify(input),
    },
    { type: "finish", finishReason: "tool-calls", usage },
  ]),
});

const textTurn = (text: string) => ({
  stream: convertArrayToReadableStream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: "stop", usage },
  ]),
});

const failingTurn = (error: unknown) => ({
  stream: convertArrayToReadableStream([
    { type: "stream-start", warnings: [] },
    { type: "error", error },
    { type: "finish", finishReason: "error", usage },
  ]),
});

const userMessage: UIMessage = {
  id: "u1",
  role: "user",
  parts: [{ type: "text", text: "look up order 7" }],
};

let toolsCleanup: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  toolsCleanup = vi.fn(async () => {});
  vi.mocked(buildTools).mockResolvedValue({
    tools: {
      lookup: tool({
        description: "looks an order up",
        inputSchema: z.object({ orderId: z.string() }),
        execute: async (): Promise<string> => {
          throw new Error("boom-detail: endpoint unreachable");
        },
      }),
    },
    approvalToolNames: new Set(),
    toolKinds: new Map([["lookup", "tool"]]),
    mcpFailures: [],
    cleanup: toolsCleanup,
  });
});

async function runTurn(doStream: unknown[]) {
  vi.mocked(buildProvider).mockReturnValue(
    new MockLanguageModelV4({ doStream: doStream as never }) as never,
  );
  const onRunEnd = vi.fn(async () => "run-1");
  const onTranscript = vi.fn();
  const response = await streamAgentForUI(agent, [userMessage], {
    onRunEnd,
    onTranscript,
  });
  await response.text();
  await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledTimes(1));
  const [, output] = onTranscript.mock.calls[0] as [UIMessage[], UIMessage[]];
  const toolPart = output
    .flatMap((message) => message.parts)
    .find((part) => isToolUIPart(part));
  return { onRunEnd, toolPart, output };
}

describe("Playground tool errors, against the real SDK", () => {
  it("keeps a thrown tool error's message and does not fail a run the loop recovered from", async () => {
    const { onRunEnd, toolPart, output } = await runTurn([
      toolCallTurn({ orderId: "7" }),
      textTurn("The lookup failed, sorry."),
    ]);

    expect(toolPart).toMatchObject({ state: "output-error" });
    expect(toolPart && "errorText" in toolPart && toolPart.errorText).toContain(
      "boom-detail: endpoint unreachable",
    );
    expect(JSON.stringify(output)).toContain("The lookup failed, sorry.");
    expect(onRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ error: undefined }),
    );
    expect(toolsCleanup).toHaveBeenCalledTimes(1);
  });

  it("keeps an invalid tool input's message and does not fail the run", async () => {
    const { onRunEnd, toolPart } = await runTurn([
      toolCallTurn({ orderId: 7 }),
      textTurn("Let me retry with a valid id."),
    ]);

    expect(toolPart).toMatchObject({ state: "output-error" });
    const errorText =
      (toolPart && "errorText" in toolPart ? toolPart.errorText : "") ?? "";
    expect(errorText).not.toBe("An error occurred.");
    expect(errorText.length).toBeGreaterThan(0);
    expect(onRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ error: undefined }),
    );
  });

  it("still records a provider failure as the run's error and masks it in the stream", async () => {
    const providerError = new Error("provider exploded");
    vi.mocked(buildProvider).mockReturnValue(
      new MockLanguageModelV4({
        doStream: [failingTurn(providerError)] as never,
      }) as never,
    );
    const onRunEnd = vi.fn(async () => "run-1");
    const response = await streamAgentForUI(agent, [userMessage], {
      onRunEnd,
    });
    const body = await response.text();

    await vi.waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));
    expect(onRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ error: providerError }),
    );
    expect(body).toContain("An error occurred.");
    expect(body).not.toContain("provider exploded");
  });
});
