import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "@/lib/mutate";
import type { AgentCriterion, CriteriaCopySource } from "@/lib/queries";
import { CriteriaPanel } from "./criteria-panel";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));
vi.mock("@/lib/mutate", () => ({ apiRequest: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

afterEach(() => {
  vi.clearAllMocks();
});

function makeCriterion(
  overrides: Partial<AgentCriterion> = {},
): AgentCriterion {
  return {
    id: "c1",
    question: "Did it confirm first?",
    passDescription: null,
    failDescription: null,
    appliesWhen: null,
    failBelow: 0.2,
    passAbove: 0.8,
    isActive: true,
    sourceFixDraftId: null,
    sourceRunId: null,
    stats: { pass: 0, fail: 0, needsReview: 0, passRate: null },
    ...overrides,
  };
}

const copySources: CriteriaCopySource[] = [
  { agentId: "s1", agentName: "Other", criteria: [] },
];

function renderPanel(
  props: Partial<React.ComponentProps<typeof CriteriaPanel>> = {},
) {
  return render(
    <CriteriaPanel
      agentId="a1"
      autoEvaluate
      recordTraffic
      criteria={[makeCriterion()]}
      lastEvaluationError={null}
      copySources={copySources}
      {...props}
    />,
  );
}

const SUMMARY = {
  runs: 30,
  pass: 113,
  fail: 0,
  needsReview: 4,
  notApplicable: 18,
  skipped: 0,
  error: 0,
  notJudged: 0,
  stoppedEarly: null,
};

describe("CriteriaPanel", () => {
  it("says automatic evaluation is on and links to the agent form to change it", () => {
    renderPanel();

    expect(
      screen.getByText("New runs are evaluated automatically."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Change" })).toHaveAttribute(
      "href",
      "/agents/a1/edit",
    );
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("says when automatic evaluation is off", () => {
    renderPanel({ autoEvaluate: false });

    expect(screen.getByText(/Automatic evaluation is off/)).toBeInTheDocument();
  });

  it("re-evaluates recent runs, disables the button meanwhile and toasts the summary", async () => {
    const user = userEvent.setup();
    let finish!: (value: unknown) => void;
    vi.mocked(apiRequest).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    renderPanel();

    await user.click(
      screen.getByRole("button", { name: "Re-evaluate recent runs" }),
    );

    expect(apiRequest).toHaveBeenCalledWith(
      "/api/agents/a1/criteria/evaluate-recent",
      { method: "POST" },
    );
    expect(
      screen.getByRole("button", { name: "Evaluating..." }),
    ).toBeDisabled();

    finish(SUMMARY);
    await screen.findByRole("button", { name: "Re-evaluate recent runs" });

    expect(toast.success).toHaveBeenCalledWith(
      "Re-evaluated 30 runs: 113 pass · 0 fail · 4 to review · 18 not applicable",
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("warns when the run stopped early or had errors", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue({
      ...SUMMARY,
      runs: 12,
      pass: 2,
      needsReview: 0,
      notApplicable: 0,
      error: 3,
      notJudged: 9,
      stoppedEarly: "judge_failing",
    });
    renderPanel();

    await user.click(
      screen.getByRole("button", { name: "Re-evaluate recent runs" }),
    );

    expect(toast.warning).toHaveBeenCalledWith(
      "Re-evaluated 12 runs: 2 pass · 0 fail · 0 to review · 3 errors · 9 not judged · stopped early: the judge kept failing",
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("says so neutrally when there was nothing to evaluate", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue({ ...SUMMARY, runs: 0, pass: 0 });
    renderPanel();

    await user.click(
      screen.getByRole("button", { name: "Re-evaluate recent runs" }),
    );

    expect(toast.info).toHaveBeenCalledWith(
      "No runs with a stored transcript to evaluate.",
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("cannot re-evaluate without an active criterion", () => {
    renderPanel({ criteria: [makeCriterion({ isActive: false })] });

    expect(
      screen.getByRole("button", { name: "Re-evaluate recent runs" }),
    ).toBeDisabled();
  });

  describe("notices", () => {
    it("warns about unrecorded /v1 and MCP traffic with a link to the agent", () => {
      renderPanel({ recordTraffic: false });

      expect(
        screen.getByText(/Runs from \/v1 and MCP aren't evaluated/),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "Edit the agent" }),
      ).toHaveAttribute("href", "/agents/a1/edit");
    });

    it("stays quiet when traffic is recorded, or when there are no criteria yet", () => {
      const { rerender } = renderPanel({ recordTraffic: true });
      expect(screen.queryByText(/aren't evaluated/)).not.toBeInTheDocument();

      rerender(
        <CriteriaPanel
          agentId="a1"
          autoEvaluate
          recordTraffic={false}
          criteria={[]}
          lastEvaluationError={null}
          copySources={copySources}
        />,
      );
      expect(screen.queryByText(/aren't evaluated/)).not.toBeInTheDocument();
    });

    it("surfaces the last evaluation error", () => {
      renderPanel({
        lastEvaluationError: {
          message: "Decisions API returned 404",
          at: new Date("2026-10-01T12:00:00Z"),
        },
      });

      expect(
        screen.getByText(
          "The last evaluation failed: Decisions API returned 404",
        ),
      ).toBeInTheDocument();
    });

    it("shows no failure notice when the last evaluation did not error", () => {
      renderPanel();

      expect(
        screen.queryByText(/The last evaluation failed/),
      ).not.toBeInTheDocument();
    });
  });

  describe("criteria list", () => {
    it("shows the question, descriptions, condition and recent stats", () => {
      renderPanel({
        criteria: [
          makeCriterion({
            passDescription: "Asks first.",
            failDescription: "Acts at once.",
            appliesWhen: "A refund was requested?",
            stats: { pass: 13, fail: 1, needsReview: 3, passRate: 13 / 14 },
          }),
        ],
      });

      expect(screen.getByText("Did it confirm first?")).toBeInTheDocument();
      expect(screen.getByText("Passes when:")).toBeInTheDocument();
      expect(screen.getByText("Fails when:")).toBeInTheDocument();
      expect(screen.getByText("Only when:")).toBeInTheDocument();
      expect(screen.getByText("Asks first.")).toBeInTheDocument();
      expect(screen.getByText("Acts at once.")).toBeInTheDocument();
      expect(screen.getByText("A refund was requested?")).toBeInTheDocument();
      expect(screen.getByText("93%")).toBeInTheDocument();
      expect(screen.getByText(/13 pass · 1 fail/)).toBeInTheDocument();
      expect(screen.getByText("3 need review")).toBeInTheDocument();
    });

    it("shows a dash and no review count when nothing was judged", () => {
      renderPanel();

      expect(screen.getByText("—")).toBeInTheDocument();
      expect(
        screen.getByText("No verdicts in the last 30 days"),
      ).toBeInTheDocument();
      expect(screen.queryByText(/need review/)).not.toBeInTheDocument();
    });

    it("marks inactive criteria and offers to activate them", () => {
      renderPanel({ criteria: [makeCriterion({ isActive: false })] });

      expect(screen.getByText("Inactive")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Activate" }),
      ).toBeInTheDocument();
    });

    it("patches isActive from the row action", async () => {
      const user = userEvent.setup();
      vi.mocked(apiRequest).mockResolvedValue(undefined);
      renderPanel();

      await user.click(screen.getByRole("button", { name: "Deactivate" }));

      expect(apiRequest).toHaveBeenCalledWith("/api/agents/a1/criteria/c1", {
        method: "PATCH",
        body: JSON.stringify({ isActive: false }),
      });
    });

    it("confirms before deleting and says verdicts go with it", async () => {
      const user = userEvent.setup();
      vi.mocked(apiRequest).mockResolvedValue(undefined);
      renderPanel();

      await user.click(screen.getByRole("button", { name: "Delete" }));
      expect(
        screen.getByText(/also deletes every verdict recorded/),
      ).toBeInTheDocument();
      expect(apiRequest).not.toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: "Confirm delete" }));
      expect(apiRequest).toHaveBeenCalledWith("/api/agents/a1/criteria/c1", {
        method: "DELETE",
      });
    });

    it("opens the dialog prefilled when editing", async () => {
      const user = userEvent.setup();
      renderPanel();

      await user.click(screen.getByRole("button", { name: "Edit" }));

      expect(screen.getByLabelText("Question")).toHaveValue(
        "Did it confirm first?",
      );
    });
  });

  describe("empty state", () => {
    it("explains criteria and offers a single Add criterion button", async () => {
      const user = userEvent.setup();
      renderPanel({ criteria: [] });

      expect(
        screen.getByText(/Yes\/no questions a judge answers about every run/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/turn a fix draft into a criterion/),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Re-evaluate recent runs" }),
      ).toBeDisabled();

      const add = screen.getAllByRole("button", { name: "Add criterion" });
      expect(add).toHaveLength(1);
      await user.click(add[0]);
      expect(screen.getByLabelText("Question")).toHaveValue("");
    });

    it("disables copying when no other agent has criteria", () => {
      renderPanel({ criteria: [], copySources: [] });

      expect(
        screen.getByRole("button", { name: "Copy from agent…" }),
      ).toBeDisabled();
    });
  });
});
