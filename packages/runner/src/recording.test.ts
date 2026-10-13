import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@agentlathe/db", async (importOriginal) => ({
  isTrackingEnabled: (await importOriginal<typeof import("@agentlathe/db")>())
    .isTrackingEnabled,
  getSettings: vi.fn(),
  recordAgentRun: vi.fn(),
  saveRunTranscript: vi.fn(),
}));
vi.mock("./versions", () => ({ resolveAgentVersion: vi.fn() }));

import { getSettings, recordAgentRun, saveRunTranscript } from "@agentlathe/db";
import type { AgentRow } from "./loaders";
import {
  addChildRunStats,
  createRunRecorder,
  createRunStatsCollector,
  emptyRunStats,
} from "./recording";
import type { ToolKind } from "./tools";
import { resolveAgentVersion } from "./versions";

const toolKinds = new Map<string, ToolKind>([
  ["fetch_data", "tool"],
  ["gh__list_issues", "mcp"],
  ["subagent_writer", "sub_agent"],
  ["load_skill", "skill"],
]);

const hooksOf = (collector: ReturnType<typeof createRunStatsCollector>) =>
  collector.callbacks as unknown as {
    onToolExecutionEnd: (event: unknown) => void;
    onStepEnd: (event: unknown) => void;
  };

const executionEnd = (
  toolName: string,
  overrides: { type?: string; ms?: number; input?: unknown } = {},
) => ({
  toolCall: { toolName, input: overrides.input },
  toolOutput: { type: overrides.type ?? "tool-result" },
  toolExecutionMs: overrides.ms ?? 120,
});

describe("createRunStatsCollector — one producer for every transport", () => {
  it("an executed call records kind, duration and ok status", () => {
    const collector = createRunStatsCollector(toolKinds);
    hooksOf(collector).onToolExecutionEnd(executionEnd("fetch_data"));

    expect(collector.snapshot()).toMatchObject({
      toolCalls: 1,
      calls: [
        { kind: "tool", name: "fetch_data", durationMs: 120, status: "ok" },
      ],
    });
  });

  it("a tool-error output records status error", () => {
    const collector = createRunStatsCollector(toolKinds);
    hooksOf(collector).onToolExecutionEnd(
      executionEnd("gh__list_issues", { type: "tool-error" }),
    );

    expect(collector.snapshot().calls[0]).toMatchObject({
      kind: "mcp",
      status: "error",
    });
  });

  it("a load_skill call records the skill name from its input", () => {
    const collector = createRunStatsCollector(toolKinds);
    hooksOf(collector).onToolExecutionEnd(
      executionEnd("load_skill", { input: { name: "Support tone" } }),
    );

    expect(collector.snapshot().calls[0]).toMatchObject({
      kind: "skill",
      name: "Support tone",
    });
  });

  it("steps accumulate counts and token usage", () => {
    const collector = createRunStatsCollector(toolKinds);
    hooksOf(collector).onStepEnd({
      usage: { inputTokens: 100, outputTokens: 20 },
      content: [],
    });
    hooksOf(collector).onStepEnd({
      usage: { inputTokens: 50, outputTokens: 5 },
      content: [],
    });

    expect(collector.snapshot()).toMatchObject({
      steps: 2,
      inputTokens: 150,
      outputTokens: 25,
    });
  });

  it("tokens stay null when the provider reports no usage", () => {
    const collector = createRunStatsCollector(toolKinds);
    hooksOf(collector).onStepEnd({ usage: {}, content: [] });

    expect(collector.snapshot()).toMatchObject({
      inputTokens: null,
      outputTokens: null,
    });
  });

  it("denied approvals surface as denied calls via the execution-denied output", () => {
    const collector = createRunStatsCollector(toolKinds);
    hooksOf(collector).onStepEnd({
      usage: {},
      content: [
        {
          type: "tool-result",
          toolName: "fetch_data",
          output: { type: "execution-denied" },
        },
        { type: "tool-result", toolName: "gh__list_issues", output: {} },
      ],
    });

    expect(collector.snapshot().calls).toEqual([
      { kind: "tool", name: "fetch_data", status: "denied" },
    ]);
  });

  it("approval requests are counted, automatic ones are not", () => {
    const collector = createRunStatsCollector(toolKinds);
    hooksOf(collector).onStepEnd({
      usage: {},
      content: [
        { type: "tool-approval-request", isAutomatic: false },
        { type: "tool-approval-request", isAutomatic: true },
        { type: "text" },
      ],
    });

    expect(collector.snapshot().approvalsRequested).toBe(1);
  });

  it("snapshot returns a copy: later events do not mutate earlier snapshots", () => {
    const collector = createRunStatsCollector(toolKinds);
    const before = collector.snapshot();
    hooksOf(collector).onToolExecutionEnd(executionEnd("fetch_data"));

    expect(before.calls).toHaveLength(0);
    expect(collector.snapshot().calls).toHaveLength(1);
  });
});

describe("addChildRunStats — folding a sub-agent into its parent", () => {
  it("sums steps, tool calls and tokens; leaves approvals and calls alone", () => {
    const target = {
      ...emptyRunStats(),
      steps: 1,
      approvalsRequested: 1,
      calls: [{ kind: "sub_agent" as const, name: "subagent_x" }],
    };

    addChildRunStats(target, {
      ...emptyRunStats(),
      steps: 3,
      toolCalls: 2,
      inputTokens: 10,
      outputTokens: 5,
      approvalsRequested: 9,
      calls: [{ kind: "tool", name: "inner" }],
    });

    expect(target).toMatchObject({
      steps: 4,
      toolCalls: 2,
      inputTokens: 10,
      outputTokens: 5,
      approvalsRequested: 1,
    });
    expect(target.calls).toHaveLength(1);
  });

  it("tokens stay null when the child reported none", () => {
    const target = emptyRunStats();
    addChildRunStats(target, emptyRunStats());

    expect(target.inputTokens).toBeNull();
    expect(target.outputTokens).toBeNull();
  });
});

const agentRow = (overrides: Partial<AgentRow> = {}) =>
  ({
    id: "agent-1",
    model: "openrouter/model",
    recordTraffic: false,
    ...overrides,
  }) as AgentRow;

describe("createRunRecorder — the single writer of the run record", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(recordAgentRun).mockResolvedValue("run-1");
    vi.mocked(resolveAgentVersion).mockResolvedValue("version-1");
    vi.mocked(getSettings).mockResolvedValue({
      trackDashboardRuns: true,
      trackV1Runs: true,
      trackMcpRuns: false,
      agentRunTtlDays: 90,
      transcriptTtlDays: 14,
      judgeModel: "typesafe/jev-1.13",
    });
  });

  it("resolves the agent version of a tracked source and records it with the run", async () => {
    const recorder = createRunRecorder({ agent: agentRow(), source: "v1" });
    await recorder.record({});

    expect(resolveAgentVersion).toHaveBeenCalledWith("agent-1");
    expect(recordAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ agentVersionId: "version-1" }),
    );
  });

  it("resolves the version when the recorder is created, not when it records", async () => {
    createRunRecorder({ agent: agentRow(), source: "v1" });

    await vi.waitFor(() =>
      expect(resolveAgentVersion).toHaveBeenCalledWith("agent-1"),
    );
    expect(recordAgentRun).not.toHaveBeenCalled();
  });

  it("a slow version resolution does not inflate the recorded duration", async () => {
    vi.useFakeTimers();
    try {
      let release: (id: string) => void = () => {};
      vi.mocked(resolveAgentVersion).mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      const recorder = createRunRecorder({ agent: agentRow(), source: "v1" });
      const pending = recorder.record({});
      vi.advanceTimersByTime(10_000);
      release("version-1");
      await pending;

      expect(recordAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({ agentVersionId: "version-1", durationMs: 0 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("never resolves a version for an untracked source", async () => {
    const recorder = createRunRecorder({ agent: agentRow(), source: "mcp" });
    await recorder.record({});

    expect(resolveAgentVersion).not.toHaveBeenCalled();
    expect(recordAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ agentVersionId: null }),
    );
  });

  it("a settings failure still records the run, without a version", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    vi.mocked(getSettings).mockRejectedValue(new Error("db down"));
    const recorder = createRunRecorder({ agent: agentRow(), source: "v1" });

    expect(await recorder.record({})).toBe("run-1");
    expect(resolveAgentVersion).not.toHaveBeenCalled();
    expect(recordAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ agentVersionId: null }),
    );
    consoleError.mockRestore();
  });

  it("a failed version resolution still records the run, without a version", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    vi.mocked(resolveAgentVersion).mockRejectedValue(new Error("db down"));
    const recorder = createRunRecorder({ agent: agentRow(), source: "v1" });

    const runId = await recorder.record({});

    expect(runId).toBe("run-1");
    expect(recordAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ agentVersionId: null }),
    );
    consoleError.mockRestore();
  });

  it("records the run with agent identity, source and normalized ok status", async () => {
    const recorder = createRunRecorder({
      agent: agentRow(),
      source: "v1",
      threadId: "t-1",
    });
    const runId = await recorder.record({ stats: emptyRunStats() });

    expect(runId).toBe("run-1");
    expect(recordAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        source: "v1",
        threadId: "t-1",
        model: "openrouter/model",
        status: "ok",
        error: null,
        durationMs: expect.any(Number),
      }),
    );
  });

  it("normalizes errors: Error message, or String(error) for the rest", async () => {
    const recorder = createRunRecorder({ agent: agentRow(), source: "mcp" });
    await recorder.record({ error: new Error("boom") });
    await recorder.record({ error: "weird throw" });

    expect(recordAgentRun).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ status: "error", error: "boom" }),
    );
    expect(recordAgentRun).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ status: "error", error: "weird throw" }),
    );
  });

  it("the Playground always stores a transcript, even with record_traffic off", async () => {
    const recorder = createRunRecorder({
      agent: agentRow({ recordTraffic: false }),
      source: "dashboard",
    });
    await recorder.record({});
    await recorder.attachTranscript(["in"], ["out"]);

    expect(saveRunTranscript).toHaveBeenCalledWith("run-1", ["in"], ["out"]);
  });

  it("external traffic is only stored when the agent opted in", async () => {
    const optedOut = createRunRecorder({
      agent: agentRow({ recordTraffic: false }),
      source: "v1",
    });
    await optedOut.record({});
    await optedOut.attachTranscript(["in"], ["out"]);
    expect(saveRunTranscript).not.toHaveBeenCalled();

    const optedIn = createRunRecorder({
      agent: agentRow({ recordTraffic: true }),
      source: "mcp",
    });
    await optedIn.record({});
    await optedIn.attachTranscript(["in"], ["out"]);
    expect(saveRunTranscript).toHaveBeenCalledTimes(1);
  });

  it("no run row means no transcript, no matter the gates", async () => {
    vi.mocked(recordAgentRun).mockResolvedValue(null);
    const recorder = createRunRecorder({
      agent: agentRow({ recordTraffic: true }),
      source: "dashboard",
    });
    await recorder.record({});
    await recorder.attachTranscript(["in"], ["out"]);

    expect(saveRunTranscript).not.toHaveBeenCalled();
    expect(recorder.runId()).toBeNull();
  });

  describe("onTranscriptSaved", () => {
    beforeEach(() => {
      vi.mocked(saveRunTranscript).mockResolvedValue(true);
    });

    it("fires once with the run id after the transcript is stored", async () => {
      const onTranscriptSaved = vi.fn();
      const recorder = createRunRecorder({
        agent: agentRow(),
        source: "dashboard",
        onTranscriptSaved,
      });
      await recorder.record({});
      await recorder.attachTranscript(["in"], ["out"]);

      expect(onTranscriptSaved).toHaveBeenCalledTimes(1);
      expect(onTranscriptSaved).toHaveBeenCalledWith("run-1");
    });

    it("does not fire when tracking produced no run row", async () => {
      vi.mocked(recordAgentRun).mockResolvedValue(null);
      const onTranscriptSaved = vi.fn();
      const recorder = createRunRecorder({
        agent: agentRow(),
        source: "dashboard",
        onTranscriptSaved,
      });
      await recorder.record({});
      await recorder.attachTranscript(["in"], ["out"]);

      expect(onTranscriptSaved).not.toHaveBeenCalled();
    });

    it("does not fire when record_traffic keeps external traffic out", async () => {
      const onTranscriptSaved = vi.fn();
      for (const source of ["v1", "mcp"] as const) {
        const recorder = createRunRecorder({
          agent: agentRow({ recordTraffic: false }),
          source,
          onTranscriptSaved,
        });
        await recorder.record({});
        await recorder.attachTranscript(["in"], ["out"]);
      }

      expect(saveRunTranscript).not.toHaveBeenCalled();
      expect(onTranscriptSaved).not.toHaveBeenCalled();
    });

    it("does not fire when the transcript write failed", async () => {
      vi.mocked(saveRunTranscript).mockResolvedValue(false);
      const onTranscriptSaved = vi.fn();
      const recorder = createRunRecorder({
        agent: agentRow({ recordTraffic: true }),
        source: "v1",
        onTranscriptSaved,
      });
      await recorder.record({});
      await recorder.attachTranscript(["in"], ["out"]);

      expect(saveRunTranscript).toHaveBeenCalledTimes(1);
      expect(onTranscriptSaved).not.toHaveBeenCalled();
    });

    it("a throwing callback does not break attachTranscript", async () => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const recorder = createRunRecorder({
        agent: agentRow(),
        source: "dashboard",
        onTranscriptSaved: () => {
          throw new Error("scheduler down");
        },
      });
      await recorder.record({});

      await expect(
        recorder.attachTranscript(["in"], ["out"]),
      ).resolves.toBeUndefined();
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });
  });

  it("a transcript attached before any record is a no-op", async () => {
    const recorder = createRunRecorder({
      agent: agentRow(),
      source: "dashboard",
    });
    await recorder.attachTranscript(["in"], ["out"]);

    expect(saveRunTranscript).not.toHaveBeenCalled();
  });
});
