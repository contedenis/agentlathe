import { beforeEach, describe, expect, it, vi } from "vitest";

const generateQueue: unknown[] = [];
const generateCalls: Array<{ messages: unknown[] }> = [];
const constructedConfigs: unknown[] = [];

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  class MockToolLoopAgent {
    config: unknown;
    constructor(config: unknown) {
      this.config = config;
      constructedConfigs.push(config);
    }
    async generate(options: { messages: unknown[] }) {
      generateCalls.push(options);
      const next = generateQueue.shift();
      if (!next) throw new Error("generate called with no scripted result");
      return next;
    }
  }
  return { ...actual, ToolLoopAgent: MockToolLoopAgent };
});
vi.mock("./loaders", () => ({
  loadAgentConfig: vi.fn(),
  loadSkills: vi.fn(async () => []),
}));
vi.mock("./tools", () => ({ buildTools: vi.fn() }));
vi.mock("./helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./helpers")>();
  return { ...actual, buildProvider: vi.fn(() => ({ model: "stub" })) };
});

import { buildScheduledToolApproval } from "./approval";
import { generateWithApprovals } from "./generate-with-approvals";
import type { AgentRow } from "./loaders";
import { buildTools } from "./tools";

const agent = {
  id: "agent-1",
  model: "openrouter/model",
  systemPrompt: "",
  maxSteps: 5,
} as AgentRow;

let cleanup: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  generateQueue.length = 0;
  generateCalls.length = 0;
  constructedConfigs.length = 0;
  cleanup = vi.fn(async () => {});
  vi.mocked(buildTools).mockResolvedValue({
    tools: {},
    approvalToolNames: new Set(["danger"]),
    toolKinds: new Map(),
    mcpFailures: [],
    cleanup,
  });
});

const finalResult = (text: string) => ({
  text,
  content: [],
  response: { messages: [] },
});

const approvalResult = (toolName: string, approvalId: string) => ({
  text: "",
  content: [
    {
      type: "tool-approval-request",
      isAutomatic: false,
      approvalId,
      toolCall: { toolName, input: { q: 1 } },
    },
  ],
  response: { messages: [{ role: "assistant", content: "may I?" }] },
});

const lastDecisions = () => {
  const messages = generateCalls.at(-1)?.messages as Array<{
    role: string;
    content: unknown;
  }>;
  return messages.at(-1)?.content as Array<{
    approvalId: string;
    approved: boolean;
  }>;
};

describe("generateWithApprovals — the approval loop", () => {
  it("a run with no approval requests returns in one round and cleans up", async () => {
    generateQueue.push(finalResult("done"));

    const { text } = await generateWithApprovals(agent, "hola");

    expect(text).toBe("done");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("an approved request continues the loop with an approved response", async () => {
    generateQueue.push(approvalResult("danger", "ap-1"), finalResult("done"));
    const askApproval = vi.fn(async () => true);

    const { text, stats } = await generateWithApprovals(agent, "hola", {
      askApproval,
    });

    expect(askApproval).toHaveBeenCalledWith({
      approvalId: "ap-1",
      toolName: "danger",
      input: { q: 1 },
    });
    expect(lastDecisions()).toEqual([
      { type: "tool-approval-response", approvalId: "ap-1", approved: true },
    ]);
    expect(text).toBe("done");
    expect(stats.approvalsGranted).toBe(1);
  });

  it("builds one runtime for the whole run and cleans it up once", async () => {
    generateQueue.push(approvalResult("danger", "ap-1"), finalResult("done"));

    await generateWithApprovals(agent, "hola", {
      askApproval: async () => true,
    });

    expect(buildTools).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("maxSteps caps the whole run: the stop condition counts steps across rounds", async () => {
    generateQueue.push(finalResult("done"));

    await generateWithApprovals(agent, "hola");

    const config = constructedConfigs.at(-1) as {
      stopWhen: (options: { steps: unknown[] }) => boolean;
    };
    expect(config.stopWhen({ steps: new Array(5) })).toBe(true);
    expect(config.stopWhen({ steps: new Array(4) })).toBe(false);
  });

  it("a denied tool is memoized: the client is never asked twice for it", async () => {
    generateQueue.push(
      approvalResult("danger", "ap-1"),
      approvalResult("danger", "ap-2"),
      finalResult("gave up"),
    );
    const askApproval = vi.fn(async () => false);

    const { text, stats } = await generateWithApprovals(agent, "hola", {
      askApproval,
    });

    expect(askApproval).toHaveBeenCalledTimes(1);
    expect(lastDecisions()).toEqual([
      { type: "tool-approval-response", approvalId: "ap-2", approved: false },
    ]);
    expect(text).toBe("gave up");
    expect(stats.approvalsGranted).toBe(0);
  });

  it("headless (no askApproval): every request is denied without asking", async () => {
    generateQueue.push(approvalResult("danger", "ap-1"), finalResult("denied"));

    const { text, stats } = await generateWithApprovals(agent, "hola");

    expect(lastDecisions()).toEqual([
      { type: "tool-approval-response", approvalId: "ap-1", approved: false },
    ]);
    expect(text).toBe("denied");
    expect(stats.approvalsGranted).toBe(0);
  });

  it("headless denials explain themselves per transport: the API by default, scheduled runs when asked", async () => {
    const deniedReason = () => {
      const { toolApproval } = constructedConfigs.at(-1) as {
        toolApproval: (opts: { toolCall: { toolName: string } }) => {
          reason: string;
        };
      };
      return toolApproval({ toolCall: { toolName: "danger" } }).reason;
    };

    generateQueue.push(finalResult("done"));
    await generateWithApprovals(agent, "hola");
    expect(deniedReason()).toBe(
      "tool 'danger' requires approval; not available over the API",
    );

    generateQueue.push(finalResult("done"));
    await generateWithApprovals(agent, "hola", {
      headlessApproval: buildScheduledToolApproval,
    });
    expect(deniedReason()).toBe(
      "tool 'danger' requires approval; not available in scheduled runs",
    );
  });

  it("reports progress while waiting for an approval", async () => {
    generateQueue.push(approvalResult("danger", "ap-1"), finalResult("done"));
    const onProgress = vi.fn();

    await generateWithApprovals(agent, "hola", {
      askApproval: async () => true,
      onProgress,
    });

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Awaiting approval for danger" }),
    );
  });

  it("propagates the abortSignal into every generate round", async () => {
    generateQueue.push(approvalResult("danger", "ap-1"), finalResult("done"));
    const abort = new AbortController();

    await generateWithApprovals(agent, "hola", {
      askApproval: async () => true,
      abortSignal: abort.signal,
    });

    expect(generateCalls).toHaveLength(2);
    for (const call of generateCalls)
      expect((call as { abortSignal?: AbortSignal }).abortSignal).toBe(
        abort.signal,
      );
  });

  it("an already-aborted signal stops the loop before calling the model", async () => {
    const abort = new AbortController();
    abort.abort();

    await expect(
      generateWithApprovals(agent, "hola", { abortSignal: abort.signal }),
    ).rejects.toThrow();
    expect(generateCalls).toHaveLength(0);
  });

  it("onStats reports the same stats the caller gets back on the success path", async () => {
    generateQueue.push(finalResult("done"));
    const onStats = vi.fn();

    const { stats } = await generateWithApprovals(agent, "hola", { onStats });

    expect(onStats).toHaveBeenCalledTimes(1);
    expect(onStats).toHaveBeenCalledWith(stats);
  });

  it("onStats still reports the consumption when the run throws (the only way a failed run gets recorded)", async () => {
    generateQueue.push(
      approvalResult("danger", "ap-1"),
      approvalResult("danger", "ap-2"),
    );
    const onStats = vi.fn();

    await expect(
      generateWithApprovals(agent, "hola", {
        askApproval: async () => true,
        maxRounds: 2,
        onStats,
      }),
    ).rejects.toThrow("exceeded 2 approval rounds");
    expect(onStats).toHaveBeenCalledTimes(1);
    expect(onStats).toHaveBeenCalledWith(
      expect.objectContaining({ approvalsGranted: 2 }),
    );
  });

  it("throws after maxRounds without a final answer, still cleaning up", async () => {
    generateQueue.push(
      approvalResult("danger", "ap-1"),
      approvalResult("danger", "ap-2"),
    );

    await expect(
      generateWithApprovals(agent, "hola", {
        askApproval: async () => true,
        maxRounds: 2,
      }),
    ).rejects.toThrow("exceeded 2 approval rounds");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
