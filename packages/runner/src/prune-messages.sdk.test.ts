import { type ModelMessage, pruneMessages } from "ai";
import { describe, expect, it, vi } from "vitest";

vi.mock("./helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./helpers")>();
  return { ...actual, getContextLimit: vi.fn(async () => 100) };
});

import { getContextLimit } from "./helpers";
import type { AgentRow } from "./loaders";
import { buildPrepareStep } from "./runtime";

const PRUNE_OPTIONS = { toolCalls: "before-last-3-messages" } as const;

// The trailing pair sits inside the 3-message window on purpose: a shrunk window strips it.
function conversation(): ModelMessage[] {
  return [
    { role: "user", content: "weather in BA and Madrid?" },
    toolCall("call_ba", "BA"),
    toolResult("call_ba", "18C"),
    { role: "assistant", content: "BA is 18C." },
    toolCall("call_madrid", "Madrid"),
    toolResult("call_madrid", "25C"),
    { role: "assistant", content: "Madrid is 25C." },
  ];
}

function toolCall(id: string, city: string): ModelMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text: `checking ${city}` },
      {
        type: "tool-call",
        toolCallId: id,
        toolName: "get_weather",
        input: { city },
      },
    ],
  };
}

function toolResult(id: string, value: string): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: "get_weather",
        output: { type: "text", value },
      },
    ],
  };
}

function partIds(messages: ModelMessage[], type: string): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === type)
        ids.push((part as { toolCallId: string }).toolCallId);
    }
  }
  return ids.sort();
}

// A tool-call without its result, or the reverse, makes the provider reject the request.
function expectNoOrphans(messages: ModelMessage[]) {
  expect(partIds(messages, "tool-result")).toEqual(
    partIds(messages, "tool-call"),
  );
}

describe("pruneMessages contract with ai@7 — before-last-3-messages", () => {
  it("keeps the last 3 messages intact and drops the tool traffic older than them", () => {
    const messages = conversation();

    const pruned = pruneMessages({ messages, ...PRUNE_OPTIONS });

    expect(pruned.slice(-3)).toEqual(messages.slice(-3));
    expectNoOrphans(pruned);
    expect(partIds(pruned, "tool-call")).toEqual(["call_madrid"]);
    expect(pruned).toEqual([
      { role: "user", content: "weather in BA and Madrid?" },
      { role: "assistant", content: [{ type: "text", text: "checking BA" }] },
      { role: "assistant", content: "BA is 18C." },
      toolCall("call_madrid", "Madrid"),
      toolResult("call_madrid", "25C"),
      { role: "assistant", content: "Madrid is 25C." },
    ]);
  });

  it("a tool-call older than the window whose result is INSIDE it survives whole", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "weather in BA and Madrid?" },
      toolCall("call_ba", "BA"),
      toolResult("call_ba", "18C"),
      toolCall("call_madrid", "Madrid"),
      toolResult("call_madrid", "25C"),
    ];

    const pruned = pruneMessages({ messages, ...PRUNE_OPTIONS });

    expect(pruned).toEqual(messages);
    expectNoOrphans(pruned);
  });

  it("last 3 messages without tool parts → every pair is dropped, text survives", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "weather in BA?" },
      toolCall("call_ba", "BA"),
      toolResult("call_ba", "18C"),
      { role: "assistant", content: "18C." },
      { role: "user", content: "thanks" },
      { role: "assistant", content: "you're welcome" },
    ];

    const pruned = pruneMessages({ messages, ...PRUNE_OPTIONS });

    expect(partIds(pruned, "tool-call")).toEqual([]);
    expectNoOrphans(pruned);
    expect(pruned).toEqual([
      { role: "user", content: "weather in BA?" },
      { role: "assistant", content: [{ type: "text", text: "checking BA" }] },
      { role: "assistant", content: "18C." },
      { role: "user", content: "thanks" },
      { role: "assistant", content: "you're welcome" },
    ]);
  });

  it("a tool message left with no parts is removed, never sent empty", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "weather in BA?" },
      toolCall("call_ba", "BA"),
      toolResult("call_ba", "18C"),
      { role: "user", content: "and now?" },
      { role: "assistant", content: "nothing new" },
      { role: "user", content: "ok" },
    ];

    const pruned = pruneMessages({ messages, ...PRUNE_OPTIONS });

    expect(pruned.some((message) => message.role === "tool")).toBe(false);
    for (const message of pruned)
      expect(message.content.length).toBeGreaterThan(0);
  });
});

describe("buildPrepareStep — compaction against the real pruneMessages", () => {
  it("over the threshold, compacts the history without orphaning any tool call", async () => {
    const messages = conversation();

    const prepareStep = buildPrepareStep({ model: "m" } as AgentRow);
    const result = (await prepareStep({ messages } as unknown as Parameters<
      ReturnType<typeof buildPrepareStep>
    >[0])) as { messages?: ModelMessage[] };

    expect(getContextLimit).toHaveBeenCalledWith("m");
    expect(result.messages).toBeDefined();
    const pruned = result.messages as ModelMessage[];
    expect(pruned.length).toBeLessThan(messages.length);
    expect(pruned.slice(-3)).toEqual(messages.slice(-3));
    expectNoOrphans(pruned);
  });
});
