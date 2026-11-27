import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  class Worker extends EventEmitter {
    terminate = vi.fn(async () => 0);
    constructor(
      _url: URL,
      options: {
        workerData: { script: string; input: unknown; timeoutMs: number };
      },
    ) {
      super();
      const { script, input, timeoutMs } = options.workerData;
      void import("./sandbox-vm").then(async ({ evaluateScript }) =>
        this.emit("message", await evaluateScript(script, input, timeoutMs)),
      );
    }
  }
  return { Worker };
});
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
vi.mock("./helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./helpers")>()),
  buildProvider: vi.fn(),
  getContextLimit: vi.fn(async () => 128_000),
}));

import { generateWithApprovals } from "./generate-with-approvals";
import { buildProvider } from "./helpers";
import { type AgentRow, loadSkills, type SkillRow } from "./loaders";
import { buildTools } from "./tools";

const agent = {
  id: "agent-1",
  model: "openrouter/model",
  systemPrompt: "You help with dates.",
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

const skill = (overrides: Partial<SkillRow> = {}): SkillRow => ({
  id: "s1",
  name: "Add days",
  description: "Adds days to a number.",
  content: "Call the script.",
  script:
    "if (input.days > 100) throw new RangeError('too many days'); return { total: input.start + input.days };",
  inputSchema: {
    type: "object",
    properties: { start: { type: "number" }, days: { type: "number" } },
    required: ["start", "days"],
  },
  needsApproval: false,
  ...overrides,
});

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
});

describe("a skill's script, against the real SDK", () => {
  it("runs when the model calls its tool, and the call is recorded as a skill", async () => {
    vi.mocked(loadSkills).mockResolvedValue([skill()]);
    const model = scriptModel([
      toolCallRound("skill_Add_days", { start: 10, days: 5 }),
      textRound("It is 15."),
    ]);

    const { text, stats } = await generateWithApprovals(
      agent,
      "10 plus 5 days?",
    );

    expect(text).toBe("It is 15.");
    expect(toolResults(model)).toEqual([
      { type: "json", value: { result: { total: 15 } } },
    ]);
    expect(stats.calls).toEqual([
      expect.objectContaining({
        kind: "skill",
        name: "skill_Add_days",
        status: "ok",
      }),
    ]);
  });

  it("hands a script error back to the model, which goes on, and records the call as failed", async () => {
    vi.mocked(loadSkills).mockResolvedValue([skill()]);
    const model = scriptModel([
      toolCallRound("skill_Add_days", { start: 1, days: 500 }),
      textRound("That is too far ahead."),
    ]);

    const { text, stats } = await generateWithApprovals(
      agent,
      "1 plus 500 days?",
    );

    expect(text).toBe("That is too far ahead.");
    expect(JSON.stringify(toolResults(model))).toContain(
      "RangeError: too many days",
    );
    expect(stats.calls).toEqual([
      expect.objectContaining({ kind: "skill", status: "error" }),
    ]);
  });

  it("is denied without running where nobody can approve it", async () => {
    vi.mocked(loadSkills).mockResolvedValue([skill({ needsApproval: true })]);
    const model = scriptModel([
      toolCallRound("skill_Add_days", { start: 10, days: 5 }),
      textRound("I cannot run that here."),
    ]);

    const { stats } = await generateWithApprovals(agent, "10 plus 5 days?");

    expect(JSON.stringify(toolResults(model))).toContain("requires approval");
    expect(stats.calls).toEqual([
      expect.objectContaining({
        kind: "skill",
        name: "skill_Add_days",
        status: "denied",
      }),
    ]);
  });
});
