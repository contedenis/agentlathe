import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
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

import { generateWithApprovals } from "./generate-with-approvals";
import { buildProvider } from "./helpers";
import type { AgentRow } from "./loaders";
import type { AgentRunStats } from "./recording";
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

const textRound = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: "stop" as const,
  usage: usage(10, 5),
  warnings: [],
});

const toolCallRound = (toolName: string, input: object) => ({
  content: [
    {
      type: "tool-call" as const,
      toolCallId: `call-${toolName}`,
      toolName,
      input: JSON.stringify(input),
    },
  ],
  finishReason: "tool-calls" as const,
  usage: usage(20, 8),
  warnings: [],
});

const dangerExecute = vi.fn(async ({ target }: { target: string }) => {
  return `deleted ${target}`;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(buildTools).mockResolvedValue({
    tools: {
      danger: tool({
        description: "needs approval",
        inputSchema: z.object({ target: z.string() }),
        execute: dangerExecute,
      }),
    },
    approvalToolNames: new Set(["danger"]),
    toolKinds: new Map([["danger", "tool"]]),
    mcpFailures: [],
    cleanup: async () => {},
  });
});

const scriptModel = (rounds: unknown[]) => {
  const model = new MockLanguageModelV4({ doGenerate: rounds as never });
  vi.mocked(buildProvider).mockReturnValue(model as never);
};

describe("generateWithApprovals against the real SDK", () => {
  it("approved: the tool executes in the next round and is recorded ok", async () => {
    scriptModel([
      toolCallRound("danger", { target: "prod" }),
      textRound("done after approval"),
    ]);

    const { text, stats } = await generateWithApprovals(agent, "delete prod", {
      askApproval: async () => true,
    });

    expect(text).toBe("done after approval");
    expect(dangerExecute).toHaveBeenCalledTimes(1);
    expect(stats.approvalsRequested).toBe(1);
    expect(stats.approvalsGranted).toBe(1);
    expect(stats.toolCalls).toBe(1);
    expect(stats.calls).toEqual([
      {
        kind: "tool",
        name: "danger",
        durationMs: expect.any(Number),
        status: "ok",
      },
    ]);
  });

  it("maxSteps counts the run's own steps across rounds, not the sub-agents' folded ones", async () => {
    const childStats: AgentRunStats = {
      steps: 7,
      toolCalls: 3,
      inputTokens: null,
      outputTokens: null,
      approvalsRequested: 0,
      approvalsGranted: 0,
      calls: [],
      mcpFailures: [],
    };
    vi.mocked(buildTools).mockImplementation(
      async (_agentId, _ctx, _buildSubAgentRuntime, onChildStats) => ({
        tools: {
          delegate: tool({
            description: "a sub-agent",
            inputSchema: z.object({ task: z.string() }),
            execute: async () => {
              onChildStats?.(childStats);
              return "child answered";
            },
          }),
          danger: tool({
            description: "needs approval",
            inputSchema: z.object({ target: z.string() }),
            execute: dangerExecute,
          }),
          echo: tool({
            description: "echoes",
            inputSchema: z.object({ value: z.string() }),
            execute: async ({ value }: { value: string }) => value,
          }),
        },
        approvalToolNames: new Set(["danger"]),
        toolKinds: new Map([
          ["delegate", "sub_agent"],
          ["danger", "tool"],
          ["echo", "tool"],
        ]),
        mcpFailures: [],
        cleanup: async () => {},
      }),
    );
    // maxSteps is 5, own steps 4. Folding the child's 7 would cut round two short.
    scriptModel([
      toolCallRound("delegate", { task: "do it" }),
      toolCallRound("danger", { target: "prod" }),
      toolCallRound("echo", { value: "still going" }),
      textRound("done"),
    ]);

    const { text, stats } = await generateWithApprovals(agent, "orchestrate", {
      askApproval: async () => true,
    });

    expect(text).toBe("done");
    // Stats still fold the child: the run really did consume those steps.
    expect(stats.steps).toBe(4 + 7);
    expect(stats.toolCalls).toBe(3 + 3);
  });

  it("denied: the tool never executes and exactly one denied call is recorded", async () => {
    scriptModel([
      toolCallRound("danger", { target: "prod" }),
      textRound("understood, not doing that"),
    ]);

    const { text, stats } = await generateWithApprovals(agent, "delete prod", {
      askApproval: async () => false,
    });

    expect(text).toBe("understood, not doing that");
    expect(dangerExecute).not.toHaveBeenCalled();
    expect(stats.approvalsRequested).toBe(1);
    expect(stats.approvalsGranted).toBe(0);
    expect(stats.toolCalls).toBe(0);
    expect(stats.calls).toEqual([
      { kind: "tool", name: "danger", status: "denied" },
    ]);
  });
});
