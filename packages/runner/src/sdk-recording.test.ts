import { stepCountIs, ToolLoopAgent, type ToolSet, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildDashboardToolApproval,
  buildHeadlessToolApproval,
} from "./approval";
import { createRunStatsCollector } from "./recording";
import type { ToolKind } from "./tools";

const usage = (input: number, output: number) => ({
  inputTokens: {
    total: input,
    noCache: input,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: output,
    text: output,
    reasoning: undefined,
  },
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

const toolKinds = new Map<string, ToolKind>([
  ["echo", "tool"],
  ["boom", "tool"],
  ["danger", "tool"],
]);

function makeHarness(options: {
  rounds: unknown[];
  toolApproval?: ReturnType<typeof buildHeadlessToolApproval>;
}) {
  const collector = createRunStatsCollector(toolKinds);
  const model = new MockLanguageModelV4({
    doGenerate: options.rounds as never,
  });
  const agent = new ToolLoopAgent({
    model,
    instructions: "You are a test agent.",
    tools: {
      echo: tool({
        description: "echoes",
        inputSchema: z.object({ value: z.string() }),
        execute: async ({ value }) => value,
      }),
      boom: tool({
        description: "always fails",
        inputSchema: z.object({ note: z.string().optional() }),
        execute: async (): Promise<string> => {
          throw new Error("kaboom");
        },
      }),
      danger: tool({
        description: "needs approval",
        inputSchema: z.object({ target: z.string() }),
        execute: async ({ target }) => `deleted ${target}`,
      }),
    } as ToolSet,
    stopWhen: stepCountIs(5),
    toolApproval: options.toolApproval,
    ...collector.callbacks,
  });
  return { agent, collector };
}

describe("real ToolLoopAgent ↔ collector contract", () => {
  it("an executed tool call is recorded ok, with duration and step usage", async () => {
    const { agent, collector } = makeHarness({
      rounds: [toolCallRound("echo", { value: "hola" }), textRound("done")],
    });

    const result = await agent.generate({ prompt: "run the echo tool" });
    const stats = collector.snapshot();

    expect(result.text).toBe("done");
    expect(stats.steps).toBe(2);
    expect(stats.toolCalls).toBe(1);
    expect(stats.calls).toEqual([
      {
        kind: "tool",
        name: "echo",
        durationMs: expect.any(Number),
        status: "ok",
      },
    ]);
    expect(stats.inputTokens).toBe(30);
    expect(stats.outputTokens).toBe(13);
  });

  it("a tool that throws is recorded as an error call", async () => {
    const { agent, collector } = makeHarness({
      rounds: [toolCallRound("boom", {}), textRound("it failed")],
    });

    await agent.generate({ prompt: "run boom" });
    const stats = collector.snapshot();

    expect(stats.calls).toEqual([
      {
        kind: "tool",
        name: "boom",
        durationMs: expect.any(Number),
        status: "error",
      },
    ]);
  });

  it("a headless denial is recorded as denied, and the tool never executes", async () => {
    const { agent, collector } = makeHarness({
      rounds: [
        toolCallRound("danger", { target: "prod" }),
        textRound("I was not allowed to do that."),
      ],
      toolApproval: buildHeadlessToolApproval(new Set(["danger"])),
    });

    const result = await agent.generate({ prompt: "delete prod" });
    const stats = collector.snapshot();

    expect(result.text).toBe("I was not allowed to do that.");
    expect(stats.toolCalls).toBe(0);
    expect(stats.calls).toEqual([
      { kind: "tool", name: "danger", status: "denied" },
    ]);
  });

  it("an interactive approval request pauses the run and counts as requested", async () => {
    const { agent, collector } = makeHarness({
      rounds: [toolCallRound("danger", { target: "prod" })],
      toolApproval: buildDashboardToolApproval(new Set(["danger"])),
    });

    const result = await agent.generate({ prompt: "delete prod" });
    const stats = collector.snapshot();

    expect(
      result.content.filter((part) => part.type === "tool-approval-request"),
    ).toHaveLength(1);
    expect(stats.approvalsRequested).toBe(1);
    expect(stats.calls).toEqual([]);
    expect(stats.toolCalls).toBe(0);
  });
});
