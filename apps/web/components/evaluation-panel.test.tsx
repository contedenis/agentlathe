import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "@/lib/mutate";
import type { RunEvaluationView } from "@/lib/queries";
import { EvaluationPanel } from "./evaluation-panel";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));
vi.mock("@/lib/mutate", () => ({ apiRequest: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

afterEach(() => {
  vi.clearAllMocks();
});

function makeEvaluation(
  overrides: Partial<RunEvaluationView> = {},
): RunEvaluationView {
  const question = overrides.questionSnapshot ?? "Did it confirm first?";
  return {
    id: "e1",
    criterionId: "c1",
    questionSnapshot: question,
    currentQuestion: question,
    criterionActive: true,
    status: "pass",
    pPass: 0.91,
    skipReason: null,
    error: null,
    reviewedVerdict: null,
    ...overrides,
  };
}

function renderCard(
  props: Partial<React.ComponentProps<typeof EvaluationPanel>> = {},
) {
  return render(
    <EvaluationPanel
      runId="run-1"
      agentId="agent-1"
      source="dashboard"
      evaluations={[makeEvaluation()]}
      hasActiveCriteria
      hasTranscript
      canNoteFix
      onNoteFix={vi.fn()}
      {...props}
    />,
  );
}

function rowOf(question: string) {
  const row = screen.getByText(question).closest("li");
  if (!row) throw new Error(`no row for ${question}`);
  return within(row);
}

describe("EvaluationPanel verdict rows", () => {
  it("orders unreviewed fails, unreviewed needs-review, errors and skips, reviewed, passes, then not applicable", () => {
    renderCard({
      evaluations: [
        makeEvaluation({
          id: "1",
          questionSnapshot: "q-na",
          status: "not_applicable",
          pPass: null,
        }),
        makeEvaluation({ id: "2", questionSnapshot: "q-pass", status: "pass" }),
        makeEvaluation({
          id: "3",
          questionSnapshot: "q-reviewed",
          status: "fail",
          reviewedVerdict: "fail",
        }),
        makeEvaluation({
          id: "4",
          questionSnapshot: "q-skipped",
          status: "skipped",
          skipReason: "too_long",
          pPass: null,
        }),
        makeEvaluation({
          id: "5",
          questionSnapshot: "q-review",
          status: "needs_review",
          pPass: 0.5,
        }),
        makeEvaluation({
          id: "6",
          questionSnapshot: "q-fail-a",
          status: "fail",
          pPass: 0.1,
        }),
        makeEvaluation({
          id: "7",
          questionSnapshot: "q-error",
          status: "error",
          error: "boom",
          pPass: null,
        }),
        makeEvaluation({
          id: "8",
          questionSnapshot: "q-fail-b",
          status: "fail",
          pPass: 0.05,
        }),
      ],
    });

    expect(
      screen
        .getAllByRole("listitem")
        .map((item) => item.querySelector("p")?.textContent),
    ).toEqual([
      "q-fail-a",
      "q-fail-b",
      "q-review",
      "q-skipped",
      "q-error",
      "q-reviewed",
      "q-pass",
      "q-na",
    ]);
  });

  it("shows the status badge and the probability with two decimals", () => {
    renderCard({
      evaluations: [makeEvaluation({ status: "needs_review", pPass: 0.5 })],
    });

    expect(screen.getByText("Needs review")).toBeInTheDocument();
    expect(screen.getByText("p 0.50")).toBeInTheDocument();
  });

  it("notes when a verdict was judged under an earlier wording", () => {
    renderCard({
      evaluations: [
        makeEvaluation({
          questionSnapshot: "Old wording?",
          currentQuestion: "New wording?",
        }),
      ],
    });

    expect(screen.getByText("Old wording?")).toBeInTheDocument();
    expect(
      screen.getByText("Judged under an earlier wording"),
    ).toBeInTheDocument();
  });

  it("does not show the earlier-wording note when the question is unchanged", () => {
    renderCard();

    expect(
      screen.queryByText("Judged under an earlier wording"),
    ).not.toBeInTheDocument();
  });

  it("flags a verdict of a deactivated criterion", () => {
    renderCard({
      evaluations: [makeEvaluation({ criterionActive: false })],
    });

    expect(screen.getByText("Criterion is inactive")).toBeInTheDocument();
  });

  it("spells out why a verdict was skipped", () => {
    renderCard({
      evaluations: [
        makeEvaluation({
          id: "1",
          questionSnapshot: "q1",
          status: "skipped",
          skipReason: "too_long",
          pPass: null,
        }),
        makeEvaluation({
          id: "2",
          questionSnapshot: "q2",
          status: "skipped",
          skipReason: "awaiting_approval",
          pPass: null,
        }),
      ],
    });

    expect(
      screen.getByText("Transcript too long for the judge"),
    ).toBeInTheDocument();
    expect(screen.getByText("Run paused on an approval")).toBeInTheDocument();
  });

  it("shows the judge error with the full text in its tooltip", () => {
    const error = `Decisions API said no. ${"x".repeat(400)}`;
    renderCard({
      evaluations: [makeEvaluation({ status: "error", error, pPass: null })],
    });

    expect(screen.getByText(error)).toHaveAttribute("title", error);
  });

  it("offers no review controls on rows that were not judged", () => {
    renderCard({
      evaluations: [
        makeEvaluation({
          id: "1",
          questionSnapshot: "q1",
          status: "not_applicable",
          pPass: null,
        }),
        makeEvaluation({
          id: "2",
          questionSnapshot: "q2",
          status: "error",
          error: "x",
          pPass: null,
        }),
      ],
    });

    expect(
      screen.queryByRole("button", { name: "Pass" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Fail" }),
    ).not.toBeInTheDocument();
  });
});

describe("EvaluationPanel human review", () => {
  it.each([
    ["Pass", "pass"],
    ["Fail", "fail"],
  ])("patches reviewedVerdict %s and refreshes", async (label, verdict) => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(undefined);
    renderCard({
      evaluations: [
        makeEvaluation({ id: "e9", status: "needs_review", pPass: 0.5 }),
      ],
    });

    await user.click(screen.getByRole("button", { name: label }));

    expect(apiRequest).toHaveBeenCalledWith("/api/runs/run-1/evaluations/e9", {
      method: "PATCH",
      body: JSON.stringify({ reviewedVerdict: verdict }),
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("undoes a review by patching null", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(undefined);
    renderCard({
      evaluations: [
        makeEvaluation({
          id: "e9",
          status: "fail",
          pPass: 0.1,
          reviewedVerdict: "fail",
        }),
      ],
    });

    expect(screen.getByText("Reviewed")).toBeInTheDocument();
    expect(screen.getByText("Fail")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Pass" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Undo" }));

    expect(apiRequest).toHaveBeenCalledWith("/api/runs/run-1/evaluations/e9", {
      method: "PATCH",
      body: JSON.stringify({ reviewedVerdict: null }),
    });
  });

  it("makes a human verdict that disagrees with the judge visible", () => {
    renderCard({
      evaluations: [
        makeEvaluation({
          id: "1",
          questionSnapshot: "q1",
          status: "fail",
          pPass: 0.1,
          reviewedVerdict: "pass",
        }),
        makeEvaluation({
          id: "2",
          questionSnapshot: "q2",
          status: "pass",
          reviewedVerdict: "pass",
        }),
      ],
    });

    expect(rowOf("q1").getByText("Pass")).toBeInTheDocument();
    expect(rowOf("q1").queryByText("Fail")).toBeNull();
    expect(rowOf("q1").getByText(/Reviewed/)).toHaveTextContent(
      "Reviewed · judge said Fail",
    );
    expect(rowOf("q2").getByText(/Reviewed/)).not.toHaveTextContent(
      "judge said",
    );
  });

  it("shows the human verdict in the badge even when the judge was unsure", () => {
    renderCard({
      evaluations: [
        makeEvaluation({
          status: "needs_review",
          pPass: 0.5,
          reviewedVerdict: "fail",
        }),
      ],
    });

    expect(screen.getByText("Fail")).toBeInTheDocument();
    expect(screen.queryByText("Needs review")).toBeNull();
    expect(screen.getByText(/Reviewed/)).toHaveTextContent(
      "judge said Needs review",
    );
  });

  it("keeps one row disabled while another is reviewed", async () => {
    const user = userEvent.setup();
    const finish: Array<(value: unknown) => void> = [];
    vi.mocked(apiRequest).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish.push(resolve);
        }),
    );
    renderCard({
      evaluations: [
        makeEvaluation({
          id: "a",
          questionSnapshot: "qa",
          status: "fail",
          pPass: 0.1,
        }),
        makeEvaluation({
          id: "b",
          questionSnapshot: "qb",
          status: "fail",
          pPass: 0.1,
        }),
      ],
    });

    await user.click(rowOf("qa").getByRole("button", { name: "Pass" }));
    expect(rowOf("qa").getByRole("button", { name: "Pass" })).toBeDisabled();
    await user.click(rowOf("qb").getByRole("button", { name: "Fail" }));
    finish[1](undefined);

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(rowOf("qa").getByRole("button", { name: "Pass" })).toBeDisabled();
  });

  it("toasts and keeps the controls when the review fails", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockRejectedValue(new Error("nope"));
    renderCard({
      evaluations: [makeEvaluation({ status: "fail", pPass: 0.1 })],
    });

    await user.click(screen.getByRole("button", { name: "Pass" }));

    expect(toast.error).toHaveBeenCalledWith("nope");
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Pass" })).toBeEnabled();
  });
});

describe("EvaluationPanel noting a fix", () => {
  it("is offered on fail and needs-review rows, and on a human fail, but not on passes", () => {
    renderCard({
      evaluations: [
        makeEvaluation({
          id: "1",
          questionSnapshot: "q-fail",
          status: "fail",
          pPass: 0.1,
        }),
        makeEvaluation({
          id: "2",
          questionSnapshot: "q-review",
          status: "needs_review",
          pPass: 0.5,
        }),
        makeEvaluation({
          id: "3",
          questionSnapshot: "q-human-fail",
          status: "pass",
          reviewedVerdict: "fail",
        }),
        makeEvaluation({ id: "4", questionSnapshot: "q-pass", status: "pass" }),
        makeEvaluation({
          id: "5",
          questionSnapshot: "q-human-pass",
          status: "fail",
          pPass: 0.1,
          reviewedVerdict: "pass",
        }),
      ],
    });

    const offered = (question: string) =>
      rowOf(question).queryByRole("button", { name: "Note a fix" }) !== null;
    expect(offered("q-fail")).toBe(true);
    expect(offered("q-review")).toBe(true);
    expect(offered("q-human-fail")).toBe(true);
    expect(offered("q-pass")).toBe(false);
    expect(offered("q-human-pass")).toBe(false);
  });

  it("hands the evaluation to the caller", async () => {
    const user = userEvent.setup();
    const onNoteFix = vi.fn();
    const evaluation = makeEvaluation({ status: "fail", pPass: 0.1 });
    renderCard({ evaluations: [evaluation], onNoteFix });

    await user.click(screen.getByRole("button", { name: "Note a fix" }));

    expect(onNoteFix).toHaveBeenCalledWith(evaluation);
  });

  it("is hidden when the transcript has no assistant turn to anchor to", () => {
    renderCard({
      evaluations: [makeEvaluation({ status: "fail", pPass: 0.1 })],
      canNoteFix: false,
    });

    expect(
      screen.queryByRole("button", { name: "Note a fix" }),
    ).not.toBeInTheDocument();
  });
});

describe("EvaluationPanel re-evaluating", () => {
  it("posts an empty body, disables the button meanwhile and toasts the totals", async () => {
    const user = userEvent.setup();
    let finish!: (value: unknown) => void;
    vi.mocked(apiRequest).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    renderCard();

    await user.click(screen.getByRole("button", { name: "Re-evaluate" }));

    expect(apiRequest).toHaveBeenCalledWith("/api/runs/run-1/evaluate", {
      method: "POST",
      body: "{}",
    });
    expect(
      screen.getByRole("button", { name: "Evaluating..." }),
    ).toBeDisabled();

    finish({
      evaluations: [
        { status: "pass" },
        { status: "fail" },
        { status: "needs_review" },
        { status: "not_applicable" },
      ],
    });

    expect(
      await screen.findByRole("button", { name: "Re-evaluate" }),
    ).toBeEnabled();
    expect(toast.success).toHaveBeenCalledWith(
      "Evaluated 4 criteria: 1 pass · 1 fail · 1 to review · 1 not applicable",
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("reports a judge failure instead of success", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue({
      evaluations: [{ status: "error" }],
      notJudged: { status: "error", skipReason: null, error: "bad key" },
    });
    renderCard();

    await user.click(screen.getByRole("button", { name: "Re-evaluate" }));

    expect(toast.error).toHaveBeenCalledWith("The judge failed: bad key");
    expect(toast.success).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
  });

  it("reports a skipped run with the reason in words", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue({
      evaluations: [{ status: "skipped" }],
      notJudged: { status: "skipped", skipReason: "too_long", error: null },
    });
    renderCard();

    await user.click(screen.getByRole("button", { name: "Re-evaluate" }));

    expect(toast.warning).toHaveBeenCalledWith(
      "Not judged: transcript too long for the judge.",
    );
  });

  it("toasts the error when the request itself fails", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockRejectedValue(new Error("Run not found."));
    renderCard();

    await user.click(screen.getByRole("button", { name: "Re-evaluate" }));

    expect(toast.error).toHaveBeenCalledWith("Run not found.");
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("EvaluationPanel empty states", () => {
  it("links to the agent page when the agent has no active criteria", () => {
    renderCard({ evaluations: [], hasActiveCriteria: false });

    expect(
      screen.getByText(/No criteria for this agent yet\./),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Add one on the agent page" }),
    ).toHaveAttribute("href", "/agents/agent-1");
    expect(
      screen.queryByRole("button", { name: "Re-evaluate" }),
    ).not.toBeInTheDocument();
  });

  it("says the run is not evaluated yet and offers Re-evaluate", () => {
    renderCard({ evaluations: [] });

    expect(screen.getByText("Not evaluated yet.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Re-evaluate" }),
    ).toBeInTheDocument();
  });

  it("explains a run without a transcript and points external sources at recording", () => {
    renderCard({ evaluations: [], hasTranscript: false, source: "v1" });

    expect(
      screen.getByText(
        /No transcript stored for this run, so it can't be evaluated\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: "Turn on external traffic recording",
      }),
    ).toHaveAttribute("href", "/agents/agent-1/edit");
    expect(
      screen.queryByRole("button", { name: "Re-evaluate" }),
    ).not.toBeInTheDocument();
  });

  it("does not suggest recording for a Playground run", () => {
    renderCard({ evaluations: [], hasTranscript: false, source: "dashboard" });

    expect(
      screen.queryByRole("link", { name: /recording/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps showing old verdicts after the agent's criteria were all deactivated", () => {
    renderCard({ hasActiveCriteria: false });

    expect(screen.getByText("Did it confirm first?")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Re-evaluate" }),
    ).not.toBeInTheDocument();
  });
});
