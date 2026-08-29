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
import type { AgentRunStats } from "./recording";
import { streamAgentForUI } from "./stream-ui";
import { buildTools } from "./tools";

const agent = {
  id: "agent-1",
  model: "openrouter/model",
  systemPrompt: "",
  maxSteps: 5,
} as AgentRow;

const usage = (input: number, output: number) => ({
  inputTokens: {
    total: input,
    noCache: input,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

const toolCallTurn = () => ({
  stream: convertArrayToReadableStream([
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: "call-danger",
      toolName: "danger",
      input: JSON.stringify({ target: "prod" }),
    },
    { type: "finish", finishReason: "tool-calls", usage: usage(5, 2) },
  ]),
});

const textTurn = (text: string) => ({
  stream: convertArrayToReadableStream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: "stop", usage: usage(5, 2) },
  ]),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(buildTools).mockResolvedValue({
    tools: {
      danger: tool({
        description: "needs approval",
        inputSchema: z.object({ target: z.string() }),
        execute: async () => "should never run",
      }),
    },
    approvalToolNames: new Set(["danger"]),
    toolKinds: new Map([["danger", "tool"]]),
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

describe("dashboard denial across turns, against the real SDK", () => {
  it("an approval denied via the next turn's input is recorded as a denied call", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallTurn(),
        textTurn("understood, not doing that"),
      ] as never,
    });
    vi.mocked(buildProvider).mockReturnValue(model as never);

    const userMessage: UIMessage = {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "clean the workspace" }],
    };

    const firstRunEnd = vi.fn(async () => "run-1");
    const firstResponse = await streamAgentForUI(agent, [userMessage], {
      onRunEnd: firstRunEnd,
    });
    const assistant = await lastUIMessage(firstResponse);

    const requested = assistant.parts.find(
      (part) => isToolUIPart(part) && part.state === "approval-requested",
    );
    if (!requested || !isToolUIPart(requested))
      throw new Error("turn 1 did not pause on an approval request");
    expect(firstRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        stats: expect.objectContaining({ approvalsRequested: 1 }),
      }),
    );

    const deniedAssistant: UIMessage = {
      ...assistant,
      parts: assistant.parts.map((part) =>
        part === requested
          ? {
              ...part,
              state: "approval-responded" as const,
              approval: { ...part.approval, approved: false },
            }
          : part,
      ) as UIMessage["parts"],
    };

    let secondStats: AgentRunStats | undefined;
    const secondResponse = await streamAgentForUI(
      agent,
      [userMessage, deniedAssistant],
      {
        onRunEnd: async ({ stats }) => {
          secondStats = stats;
          return "run-2";
        },
      },
    );
    await secondResponse.text();

    expect(secondStats?.calls).toEqual([
      { kind: "tool", name: "danger", status: "denied" },
    ]);
    expect(secondStats?.toolCalls).toBe(0);
  });

  it("an already-processed denial (output-denied) in the history is not recorded again", async () => {
    const model = new MockLanguageModelV4({
      doStream: [textTurn("hola")] as never,
    });
    vi.mocked(buildProvider).mockReturnValue(model as never);

    const history: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "clean" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-danger",
            toolCallId: "call-old",
            state: "output-denied",
            input: { target: "prod" },
            approval: { id: "ap-old", approved: false },
          } as unknown as UIMessage["parts"][number],
        ],
      },
      { id: "u2", role: "user", parts: [{ type: "text", text: "hola" }] },
    ];

    let runStats: AgentRunStats | undefined;
    const response = await streamAgentForUI(agent, history, {
      onRunEnd: async ({ stats }) => {
        runStats = stats;
        return "run-3";
      },
    });
    await response.text();

    expect(runStats?.calls).toEqual([]);
  });
});
