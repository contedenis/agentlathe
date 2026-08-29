import { beforeEach, describe, expect, it, vi } from "vitest";

const ctorSpy = vi.fn();
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    ToolLoopAgent: class {
      constructor(settings: unknown) {
        ctorSpy(settings);
      }
    },
  };
});
vi.mock("./loaders", () => ({
  loadAgentConfig: vi.fn(),
  loadSkills: vi.fn(),
}));
vi.mock("./tools", () => ({ buildTools: vi.fn() }));
vi.mock("./helpers", () => ({
  buildProvider: vi.fn(() => ({ model: "stub" })),
  getContextLimit: vi.fn(),
  estimateTokens: vi.fn(),
}));

import {
  buildDashboardToolApproval,
  buildHeadlessToolApproval,
} from "./approval";
import { type AgentRow, loadSkills } from "./loaders";
import { buildAgentRuntime } from "./runtime";
import { buildTools } from "./tools";

type ApprovalFn = (opts: { toolCall: { toolName: string } }) => unknown;
const capturedToolApproval = (): unknown =>
  (ctorSpy.mock.calls.at(-1)?.[0] as { toolApproval?: unknown }).toolApproval;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadSkills).mockResolvedValue([]);
  vi.mocked(buildTools).mockResolvedValue({
    tools: {},
    approvalToolNames: new Set(["danger"]),
    toolKinds: new Map(),
    mcpFailures: [],
    cleanup: async () => {},
  });
});

const agentRow = {
  id: "a",
  model: "anthropic/claude-opus-4.8",
  systemPrompt: "",
  maxSteps: 20,
} as AgentRow;

describe("buildDashboardToolApproval — pure function", () => {
  it("'user-approval' for tools in the set; 'not-applicable' for the rest", () => {
    const approval = buildDashboardToolApproval(
      new Set(["danger", "wipe"]),
    ) as ApprovalFn;

    expect(approval({ toolCall: { toolName: "danger" } })).toBe(
      "user-approval",
    );
    expect(approval({ toolCall: { toolName: "wipe" } })).toBe("user-approval");
    expect(approval({ toolCall: { toolName: "safe" } })).toBe("not-applicable");
  });

  it("empty set → nothing asks for approval", () => {
    const approval = buildDashboardToolApproval(new Set()) as ApprovalFn;
    expect(approval({ toolCall: { toolName: "danger" } })).toBe(
      "not-applicable",
    );
  });
});

describe("buildHeadlessToolApproval — pure function (/v1 headless)", () => {
  it("tools in the set → 'denied' with a reason; rest → 'not-applicable'; never 'user-approval'", () => {
    const approval = buildHeadlessToolApproval(
      new Set(["danger", "wipe"]),
    ) as ApprovalFn;

    const denied = approval({ toolCall: { toolName: "danger" } });
    expect(denied).toMatchObject({ type: "denied" });
    expect((denied as { reason: string }).reason).toContain("danger");
    expect(denied).not.toBe("user-approval");

    expect(approval({ toolCall: { toolName: "safe" } })).toBe("not-applicable");
  });

  it("empty set → everything 'not-applicable'", () => {
    const approval = buildHeadlessToolApproval(new Set()) as ApprovalFn;
    expect(approval({ toolCall: { toolName: "danger" } })).toBe(
      "not-applicable",
    );
  });
});

describe("buildAgentRuntime — toolApproval wiring per transport", () => {
  it("WITHOUT a strategy (default): toolApproval stays undefined", async () => {
    await buildAgentRuntime(agentRow);
    expect(capturedToolApproval()).toBeUndefined();
  });

  it("WITH the dashboard strategy: toolApproval resolves 'user-approval' only for the discovered set", async () => {
    await buildAgentRuntime(agentRow, {
      buildApproval: buildDashboardToolApproval,
    });

    const approval = capturedToolApproval() as ApprovalFn;
    expect(typeof approval).toBe("function");
    expect(approval({ toolCall: { toolName: "danger" } })).toBe(
      "user-approval",
    );
    expect(approval({ toolCall: { toolName: "other" } })).toBe(
      "not-applicable",
    );
  });
});
