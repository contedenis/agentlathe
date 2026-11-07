import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("./memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./memory")>()),
  loadMemory: vi.fn(),
}));
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
import { loadMemory, type MemoryStoreView } from "./memory";
import { buildTools } from "./tools";

const agent = {
  id: "agent-1",
  model: "openrouter/model",
  systemPrompt: "",
  maxSteps: 8,
} as AgentRow;

const usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

const textRound = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: "stop" as const,
  usage,
  warnings: [],
});

let callCount = 0;
const toolCallRound = (toolName: string, input: object) => ({
  content: [
    {
      type: "tool-call" as const,
      toolCallId: `call-${++callCount}`,
      toolName,
      input: JSON.stringify(input),
    },
  ],
  finishReason: "tool-calls" as const,
  usage,
  warnings: [],
});

const store = (overrides: Partial<MemoryStoreView> = {}): MemoryStoreView => ({
  storeId: "store-a",
  name: "Lessons",
  agentName: "Support",
  scope: "agent",
  purpose: "What you learned.",
  charLimit: 200,
  partitionKey: "agent-1",
  revision: 3,
  entries: [
    {
      shortId: "a1",
      content: "Refunds over $500 go to billing.",
      pinned: false,
      updatedAt: new Date("2026-10-01T00:00:00Z"),
    },
    {
      shortId: "a2",
      content: "Never call the legacy API.",
      pinned: true,
      updatedAt: new Date("2026-10-02T00:00:00Z"),
    },
  ],
  ...overrides,
});

const userTool = vi.fn(async () => "user tool ran");

beforeEach(() => {
  vi.clearAllMocks();
  callCount = 0;
  vi.mocked(buildTools).mockResolvedValue({
    tools: {},
    approvalToolNames: new Set(),
    toolKinds: new Map(),
    mcpFailures: [],
    cleanup: async () => {},
  });
  vi.mocked(loadMemory).mockResolvedValue({
    stores: [store()],
    seen: [{ storeId: "store-a", partitionKey: "agent-1", revision: 3 }],
    warnings: [],
  });
});

const scriptModel = (rounds: unknown[]) => {
  const model = new MockLanguageModelV4({ doGenerate: rounds as never });
  vi.mocked(buildProvider).mockReturnValue(model as never);
  return model;
};

const toolResults = (model: MockLanguageModelV4) =>
  (model.doGenerateCalls.at(-1)?.prompt ?? []).flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) =>
          part.type === "tool-result" ? [part.output] : [],
        )
      : [],
  );

describe("memory tools against the real SDK", () => {
  it("saves adds, updates and deletes as a draft for the end of the run, answering that they show up next run", async () => {
    const model = scriptModel([
      toolCallRound("memory_add", { content: "  Orders ship on Tuesdays. " }),
      toolCallRound("memory_update", {
        id: "a1",
        content: "Refunds over $800 go to billing.",
      }),
      toolCallRound("memory_delete", { id: "a1" }),
      textRound("done"),
    ]);

    const { stats } = await generateWithApprovals(agent, "learn things");

    expect(stats.memoryWrites).toHaveLength(1);
    expect(stats.memoryWrites[0]).toMatchObject({
      storeId: "store-a",
      partitionKey: "agent-1",
      baseRevision: 3,
      requireApproval: false,
      ops: [
        { op: "add", content: "Orders ship on Tuesdays." },
        {
          op: "update",
          shortId: "a1",
          content: "Refunds over $800 go to billing.",
        },
        { op: "delete", shortId: "a1" },
      ],
    });
    expect(toolResults(model)).toEqual(
      Array(3).fill({
        type: "text",
        value: "Saved; visible from the next run.",
      }),
    );
    expect(stats.calls.map((call) => [call.kind, call.name])).toEqual([
      ["memory", "memory_add"],
      ["memory", "memory_update"],
      ["memory", "memory_delete"],
    ]);
  });

  it("refuses pinned and unknown entries, credentials and a full memory as tool errors the model recovers from", async () => {
    const model = scriptModel([
      toolCallRound("memory_delete", { id: "a2" }),
      toolCallRound("memory_update", { id: "a9", content: "x" }),
      toolCallRound("memory_add", {
        content: "The key is sk-abcdefghijklmnopqrstuvwx",
      }),
      toolCallRound("memory_add", { content: "y".repeat(150) }),
      textRound("ok"),
    ]);

    const { stats, text } = await generateWithApprovals(agent, "try");

    expect(text).toBe("ok");
    expect(stats.memoryWrites).toEqual([]);
    expect(
      toolResults(model).map((output) => (output as { value: string }).value),
    ).toEqual([
      "Error: Entry a2 is pinned: only a person can change it.",
      "Error: Entry a9 does not exist. Use an id from the Memory section of your instructions.",
      "Error: This looks like a credential, and credentials never go into memory.",
      "Error: Memory full (208 / 200 characters): update or delete entries.",
    ]);
  });

  it("in a memory that needs approval, answers that the change was proposed", async () => {
    vi.mocked(loadMemory).mockResolvedValue({
      stores: [
        store({
          scope: "agent_subject",
          partitionKey: "user-42",
          requireApproval: true,
          entries: [],
        }),
      ],
      seen: [],
      warnings: [],
    });
    const model = scriptModel([
      toolCallRound("memory_add", {
        content: "Promised a callback on 2026-10-20.",
      }),
      textRound("noted"),
    ]);

    const { stats } = await generateWithApprovals(agent, "remember");

    expect(stats.memoryWrites).toMatchObject([
      {
        partitionKey: "user-42",
        requireApproval: true,
        ops: [{ op: "add", content: "Promised a callback on 2026-10-20." }],
      },
    ]);
    expect(toolResults(model)).toEqual([
      {
        type: "text",
        value: "Proposed: a person reviews it before it is saved.",
      },
    ]);
  });

  it("renames a user tool that takes a memory tool's name, so the memory tool keeps it", async () => {
    vi.mocked(buildTools).mockResolvedValue({
      tools: {
        memory_add: tool({
          description: "the user's own tool",
          inputSchema: z.object({}),
          execute: userTool,
        }),
      },
      approvalToolNames: new Set(["memory_add"]),
      toolKinds: new Map([["memory_add", "tool"]]),
      mcpFailures: [],
      cleanup: async () => {},
    });
    const model = scriptModel([
      toolCallRound("memory_add", { content: "A fact." }),
      textRound("ok"),
    ]);

    const { stats } = await generateWithApprovals(agent, "go");

    expect(userTool).not.toHaveBeenCalled();
    expect(stats.memoryWrites[0].ops).toEqual([
      { op: "add", content: "A fact." },
    ]);
    const names = model.doGenerateCalls[0].tools?.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["memory_add", "memory_add_2", "memory_delete"]),
    );
  });
});
