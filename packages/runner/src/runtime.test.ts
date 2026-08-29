import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRow } from "./loaders";

vi.mock("./helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./helpers")>();
  return { ...actual, getContextLimit: vi.fn(), estimateTokens: vi.fn() };
});
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  class MockToolLoopAgent {
    config: unknown;
    constructor(config: unknown) {
      this.config = config;
    }
  }
  return {
    ...actual,
    pruneMessages: vi.fn(),
    createAgentUIStream: vi.fn(),
    ToolLoopAgent: MockToolLoopAgent,
  };
});
vi.mock("./loaders", () => ({
  loadAgentConfig: vi.fn(async () => ({
    id: "agent-1",
    name: "Agent",
    model: "m",
    systemPrompt: "",
    maxSteps: 5,
  })),
  loadSkills: vi.fn(async () => []),
}));
vi.mock("./tools", () => ({ buildTools: vi.fn() }));

import {
  createAgentUIStream,
  pruneMessages,
  type Tool,
  type UIMessage,
} from "ai";
import { buildDashboardToolApproval } from "./approval";
import { estimateTokens, getContextLimit } from "./helpers";
import { loadSkills, type SkillRow } from "./loaders";
import { type AgentRunStats, emptyRunStats } from "./recording";
import {
  buildAgentRuntime,
  buildLoadSkillTool,
  buildPrepareStep,
  buildSystemPrompt,
} from "./runtime";
import { streamAgentForUI } from "./stream-ui";
import { buildTools } from "./tools";

const skillRow = (name: string): SkillRow => ({
  id: name,
  name,
  description: `desc ${name}`,
  content: `contenido de ${name}`,
});

const runSkillTool = (tool: Tool, name: string) =>
  (
    tool as unknown as { execute: (input: { name: string }) => Promise<string> }
  ).execute({ name });

const agent = { model: "anthropic/claude-opus-4.8" } as AgentRow;

const agentRow = {
  id: "agent-1",
  name: "Agent",
  model: "m",
  systemPrompt: "",
  maxSteps: 5,
} as AgentRow;

const stepOptions = (messages: unknown) =>
  ({ messages }) as unknown as Parameters<
    ReturnType<typeof buildPrepareStep>
  >[0];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildPrepareStep — compaction", () => {
  it("above 80% of the limit, prunes with pruneMessages and returns { messages: pruned }", async () => {
    vi.mocked(getContextLimit).mockResolvedValue(1000);
    vi.mocked(estimateTokens).mockReturnValue(801);
    const pruned = [{ role: "user", content: "kept" }];
    vi.mocked(pruneMessages).mockReturnValue(
      pruned as unknown as ReturnType<typeof pruneMessages>,
    );

    const prepareStep = buildPrepareStep(agent);
    const messages = [{ role: "user", content: "x" }];
    const result = await prepareStep(stepOptions(messages));

    expect(pruneMessages).toHaveBeenCalledWith({
      messages,
      toolCalls: "before-last-3-messages",
    });
    expect(result).toEqual({ messages: pruned });
  });

  it("below the threshold, returns {} and does NOT prune", async () => {
    vi.mocked(getContextLimit).mockResolvedValue(1000);
    vi.mocked(estimateTokens).mockReturnValue(799);

    const prepareStep = buildPrepareStep(agent);
    const result = await prepareStep(
      stepOptions([{ role: "user", content: "x" }]),
    );

    expect(result).toEqual({});
    expect(pruneMessages).not.toHaveBeenCalled();
  });
});

type CapturedOptions = {
  onEnd?: (event: { messages: UIMessage[] }) => Promise<void>;
  onError?: (error: unknown) => string;
  abortSignal?: AbortSignal;
};

describe("streamAgentForUI — cleanup and persistence", () => {
  const mockCleanup = (cleanup: () => Promise<void>) => {
    vi.mocked(buildTools).mockResolvedValue({
      tools: {},
      approvalToolNames: new Set<string>(),
      toolKinds: new Map(),
      mcpFailures: [],
      cleanup,
    });
  };

  const capture = () => {
    let captured: CapturedOptions | undefined;
    vi.mocked(createAgentUIStream).mockImplementation((options) => {
      captured = options as CapturedOptions;
      const empty = new ReadableStream({
        start: (controller) => controller.close(),
      });
      return Promise.resolve(
        empty as unknown as Awaited<ReturnType<typeof createAgentUIStream>>,
      );
    });
    return () => {
      if (!captured) throw new Error("createAgentUIStream was not called");
      return captured;
    };
  };

  it("onEnd: cleans up MCP BEFORE onFinish (a hung LLM title must not hold clients open)", async () => {
    const order: string[] = [];
    const cleanup = vi.fn(async () => {
      order.push("cleanup");
    });
    mockCleanup(cleanup);
    const getOptions = capture();
    const onFinish = vi.fn(async () => {
      order.push("finish");
    });

    await streamAgentForUI(agentRow, [], { onFinish });
    await getOptions().onEnd?.({ messages: [] });

    expect(order).toEqual(["cleanup", "finish"]);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("onError: cleans up and returns the generic message", async () => {
    const cleanup = vi.fn(async () => {});
    mockCleanup(cleanup);
    const getOptions = capture();

    await streamAgentForUI(agentRow, []);
    const message = getOptions().onError?.(new Error("boom"));

    expect(message).toBe("An error occurred.");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("onEnd: cleanup runs even if onFinish throws", async () => {
    const cleanup = vi.fn(async () => {});
    mockCleanup(cleanup);
    const getOptions = capture();
    const onFinish = vi.fn().mockRejectedValue(new Error("db down"));

    await streamAgentForUI(agentRow, [], { onFinish });
    await expect(getOptions().onEnd?.({ messages: [] })).rejects.toThrow(
      "db down",
    );

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("forwards abortSignal to createAgentUIStream", async () => {
    mockCleanup(vi.fn(async () => {}));
    const getOptions = capture();
    const signal = new AbortController().signal;

    await streamAgentForUI(agentRow, [], { abortSignal: signal });

    expect(getOptions().abortSignal).toBe(signal);
  });

  it("emits the recorded run id as a data part at the end of the stream", async () => {
    mockCleanup(vi.fn(async () => {}));
    const getOptions = capture();

    const response = await streamAgentForUI(agentRow, [], {
      onRunEnd: async () => "run-42",
    });
    await getOptions().onEnd?.({ messages: [] });
    const body = await response.text();

    expect(body).toContain("data-run");
    expect(body).toContain("run-42");
  });

  it("a failed turn reaches onRunEnd as an error, not as a healthy run", async () => {
    mockCleanup(vi.fn(async () => {}));
    const getOptions = capture();
    const onRunEnd = vi.fn(async () => "run-99");

    await streamAgentForUI(agentRow, [], { onRunEnd });
    const boom = new Error("provider exploded");
    getOptions().onError?.(boom);
    // The SDK calls onError again with the masked text; the real cause must survive.
    getOptions().onError?.(new Error("An error occurred."));
    await getOptions().onEnd?.({ messages: [] });

    expect(onRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ error: boom }),
    );
  });

  it("a turn that ends fine reports no error", async () => {
    mockCleanup(vi.fn(async () => {}));
    const getOptions = capture();
    const onRunEnd = vi.fn(async () => "run-100");

    await streamAgentForUI(agentRow, [], { onRunEnd });
    await getOptions().onEnd?.({ messages: [] });

    expect(onRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ error: undefined }),
    );
  });

  it("keeps emitting the run id after a failure, so the run can still be reviewed", async () => {
    mockCleanup(vi.fn(async () => {}));
    const getOptions = capture();

    const response = await streamAgentForUI(agentRow, [], {
      onRunEnd: async () => "run-101",
    });
    getOptions().onError?.(new Error("boom"));
    await getOptions().onEnd?.({ messages: [] });
    const body = await response.text();

    expect(body).toContain("run-101");
  });

  it("emits no run data part when the run was not recorded", async () => {
    mockCleanup(vi.fn(async () => {}));
    const getOptions = capture();

    const response = await streamAgentForUI(agentRow, [], {
      onRunEnd: async () => null,
    });
    await getOptions().onEnd?.({ messages: [] });
    const body = await response.text();

    expect(body).not.toContain("data-run");
  });

  it("createAgentUIStream rejecting (e.g. a stale tool reference) does not leak the MCP clients", async () => {
    const cleanup = vi.fn(async () => {});
    mockCleanup(cleanup);
    vi.mocked(createAgentUIStream).mockRejectedValueOnce(
      new Error("tool no longer exists"),
    );

    await expect(streamAgentForUI(agentRow, [])).rejects.toThrow(
      "tool no longer exists",
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("buildSystemPrompt — on-demand skills section", () => {
  it("empty skill list → returns the base system prompt with no skills section", () => {
    const out = buildSystemPrompt(
      { systemPrompt: "Sos un asistente." } as AgentRow,
      [],
    );
    expect(out).toBe("Sos un asistente.");
  });

  it("null systemPrompt and no skills → empty string", () => {
    const out = buildSystemPrompt({ systemPrompt: null } as AgentRow, []);
    expect(out).toBe("");
  });

  it("with skills → appends the section with each name and description", () => {
    const out = buildSystemPrompt({ systemPrompt: "Base." } as AgentRow, [
      skillRow("uno"),
      skillRow("dos"),
    ]);
    expect(out).toContain("Base.");
    expect(out).toContain("## Available skills");
    expect(out).toContain("- uno: desc uno");
    expect(out).toContain("- dos: desc dos");
  });
});

describe("buildLoadSkillTool — on-demand load with a soft error", () => {
  it("existing skill → returns its content", async () => {
    const tool = buildLoadSkillTool([skillRow("guia"), skillRow("otra")]);
    await expect(runSkillTool(tool, "guia")).resolves.toBe("contenido de guia");
  });

  it("missing skill → error message, no throw", async () => {
    const tool = buildLoadSkillTool([skillRow("guia")]);
    await expect(runSkillTool(tool, "ghost")).resolves.toBe(
      "Error: skill 'ghost' not found.",
    );
  });

  it("empty skill list → any name answers with an error, no throw", async () => {
    const tool = buildLoadSkillTool([]);
    await expect(runSkillTool(tool, "whatever")).resolves.toBe(
      "Error: skill 'whatever' not found.",
    );
  });
});

describe("buildAgentRuntime — load_skill is reserved", () => {
  it("a tool colliding with load_skill gets a suffix; load_skill stays the real one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const marker = { __marker: true } as unknown as Tool;
    vi.mocked(buildTools).mockResolvedValue({
      tools: { load_skill: marker },
      approvalToolNames: new Set<string>(),
      toolKinds: new Map(),
      mcpFailures: [],
      cleanup: async () => {},
    });

    const { agent } = await buildAgentRuntime(agentRow);

    const tools = (
      agent as unknown as { config: { tools: Record<string, unknown> } }
    ).config.tools;
    expect(tools.load_skill).not.toBe(marker);
    expect(tools.load_skill_2).toBe(marker);
    warn.mockRestore();
  });
});

describe("buildAgentRuntime — child stats and MCP failures surface in stats()", () => {
  it("merges child consumption and carries mcpFailures from buildTools", async () => {
    let reportChild: ((stats: AgentRunStats) => void) | undefined;
    vi.mocked(buildTools).mockImplementation(
      async (_id, _ctx, _buildSubAgentRuntime, onChildStats) => {
        reportChild = onChildStats;
        return {
          tools: {},
          approvalToolNames: new Set<string>(),
          toolKinds: new Map(),
          mcpFailures: ["Jira"],
          cleanup: async () => {},
        };
      },
    );

    const { stats } = await buildAgentRuntime(agentRow);
    reportChild?.({
      ...emptyRunStats(),
      steps: 4,
      toolCalls: 1,
      inputTokens: 50,
      outputTokens: 20,
    });

    const snapshot = stats();
    expect(snapshot.steps).toBe(4);
    expect(snapshot.toolCalls).toBe(1);
    expect(snapshot.inputTokens).toBe(50);
    expect(snapshot.outputTokens).toBe(20);
    expect(snapshot.mcpFailures).toEqual(["Jira"]);
  });
});

describe("buildAgentRuntime — a late failure does not leak the MCP clients", () => {
  it("loadSkills rejecting after buildTools resolved → cleanup runs, error propagates", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    vi.mocked(buildTools).mockResolvedValue({
      tools: {},
      approvalToolNames: new Set<string>(),
      toolKinds: new Map(),
      mcpFailures: [],
      cleanup,
    });
    vi.mocked(loadSkills).mockRejectedValueOnce(new Error("skills db down"));

    await expect(buildAgentRuntime(agentRow)).rejects.toThrow("skills db down");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("buildAgentRuntime — a tool renamed off load_skill keeps its approval gate", () => {
  it("approval follows the renamed tool; load_skill itself needs none", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const marker = { __marker: true } as unknown as Tool;
    vi.mocked(buildTools).mockResolvedValue({
      tools: { load_skill: marker },
      approvalToolNames: new Set(["load_skill"]),
      toolKinds: new Map([["load_skill", "tool"]]),
      mcpFailures: [],
      cleanup: async () => {},
    });

    const { agent, toolKinds } = await buildAgentRuntime(agentRow, {
      buildApproval: buildDashboardToolApproval,
    });

    const approval = (
      agent as unknown as {
        config: {
          toolApproval: (options: {
            toolCall: { toolName: string };
          }) => unknown;
        };
      }
    ).config.toolApproval;
    expect(approval({ toolCall: { toolName: "load_skill_2" } })).toBe(
      "user-approval",
    );
    expect(approval({ toolCall: { toolName: "load_skill" } })).toBe(
      "not-applicable",
    );
    expect(toolKinds.get("load_skill_2")).toBe("tool");
    expect(toolKinds.get("load_skill")).toBe("skill");
    warn.mockRestore();
  });
});

describe("buildAgentRuntime — recursion guard is seeded internally", () => {
  it("buildTools receives a fresh callStack holding only the root agent", async () => {
    vi.mocked(buildTools).mockResolvedValue({
      tools: {},
      approvalToolNames: new Set<string>(),
      toolKinds: new Map(),
      mcpFailures: [],
      cleanup: async () => {},
    });

    await buildAgentRuntime(agentRow);

    expect(buildTools).toHaveBeenCalledWith(
      "agent-1",
      {
        callStack: new Set(["agent-1"]),
        depth: 0,
        subAgentBudget: { remaining: 20 },
      },
      expect.any(Function),
      expect.any(Function),
    );
  });
});
