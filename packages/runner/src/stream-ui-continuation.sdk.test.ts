import { isToolUIPart, readUIMessageStream, tool, type UIMessage } from "ai";
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

const toolCallTurn = () => ({
  stream: convertArrayToReadableStream([
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: "call-clean",
      toolName: "clean",
      input: JSON.stringify({ target: "tmp" }),
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(buildTools).mockResolvedValue({
    tools: {
      clean: tool({
        description: "needs approval",
        inputSchema: z.object({ target: z.string() }),
        execute: async () => "deleted 3 files",
      }),
    },
    approvalToolNames: new Set(["clean"]),
    toolKinds: new Map([["clean", "tool"]]),
    mcpFailures: [],
    cleanup: async () => {},
  });
});

async function lastUIMessage(response: Response): Promise<UIMessage> {
  const chunks = (await response.text())
    .split("\n\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .filter((data) => data && data !== "[DONE]")
    .map((data) => JSON.parse(data));

  let message: UIMessage | undefined;
  for await (const update of readUIMessageStream({
    stream: convertArrayToReadableStream(chunks),
  })) {
    message = update as UIMessage;
  }
  if (!message) throw new Error("no ui message in stream");
  return message;
}

describe("dashboard approval continuation, against the real SDK", () => {
  it("stores the continued assistant message as the run's output, with the executed tool and the final answer", async () => {
    const model = new MockLanguageModelV4({
      doStream: [toolCallTurn(), textTurn("All clean.")] as never,
    });
    vi.mocked(buildProvider).mockReturnValue(model as never);

    const userMessage: UIMessage = {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "clean tmp" }],
    };

    const firstTranscript = vi.fn();
    const firstResponse = await streamAgentForUI(agent, [userMessage], {
      onTranscript: firstTranscript,
    });
    const assistant = await lastUIMessage(firstResponse);
    const requested = assistant.parts.find(
      (part) => isToolUIPart(part) && part.state === "approval-requested",
    );
    if (!requested || !isToolUIPart(requested))
      throw new Error("turn 1 did not pause on an approval request");

    await vi.waitFor(() => expect(firstTranscript).toHaveBeenCalledTimes(1));
    const [firstInput, firstOutput] = firstTranscript.mock.calls[0];
    expect(firstInput).toEqual([userMessage]);
    expect(firstOutput).toHaveLength(1);
    expect(firstOutput[0].id).toBe(assistant.id);

    const approvedAssistant: UIMessage = {
      ...assistant,
      parts: assistant.parts.map((part) =>
        part === requested
          ? {
              ...part,
              state: "approval-responded" as const,
              approval: { ...part.approval, approved: true },
            }
          : part,
      ) as UIMessage["parts"],
    };

    let stored: { input: UIMessage[]; output: UIMessage[] } | undefined;
    const secondResponse = await streamAgentForUI(
      agent,
      [userMessage, approvedAssistant],
      {
        onTranscript: (input, output) => {
          stored = { input, output };
        },
      },
    );
    const continued = await lastUIMessage(secondResponse);

    await vi.waitFor(() => expect(stored).toBeDefined());
    expect(stored?.input).toEqual([userMessage]);
    expect(stored?.output).toHaveLength(1);
    const [output] = stored?.output ?? [];
    expect(output.id).toBe(assistant.id);
    expect(output.id).toBe(continued.id);
    expect(output.parts).toContainEqual(
      expect.objectContaining({
        type: "tool-clean",
        toolCallId: "call-clean",
        state: "output-available",
        output: "deleted 3 files",
      }),
    );
    expect(output.parts).toContainEqual(
      expect.objectContaining({ type: "text", text: "All clean." }),
    );
  });
});
