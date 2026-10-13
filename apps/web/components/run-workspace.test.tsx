import type { UIMessage } from "@agentlathe/runner/chat-ui";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FixDraft } from "@/lib/fix-drafts";
import { apiRequest } from "@/lib/mutate";
import type { RunEvaluationView } from "@/lib/queries";
import { RunWorkspace } from "./run-workspace";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/mutate", () => ({ apiRequest: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

type RunWorkspaceProps = React.ComponentProps<typeof RunWorkspace>;

afterEach(() => {
  vi.clearAllMocks();
});

const draft: FixDraft = {
  id: "d1",
  messageId: "m1",
  anchor: { type: "turn" },
  category: "prompt",
  rationale: "Promised a refund.",
  proposedValue: null,
  status: "open",
  createdAt: "2026-10-01T00:00:00.000Z",
};

function renderWorkspace(rationale = draft.rationale) {
  render(
    <RunWorkspace
      agentId="agent-9"
      runId="run-7"
      source="dashboard"
      draftsEndpoint="/api/runs/run-7/fix-drafts"
      messages={[]}
      initialFixDrafts={[{ ...draft, rationale }]}
      evaluations={[]}
      hasActiveCriteria={false}
      hasTranscript
    />,
  );
}

describe("RunWorkspace promoting a fix draft", () => {
  it("opens the criterion dialog prefilled and saves it against the run's agent with the draft id", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(undefined);
    renderWorkspace();

    await user.click(
      screen.getByRole("button", { name: "Turn into criterion" }),
    );

    expect(screen.getByLabelText("Fails when")).toHaveValue(
      "Promised a refund.",
    );
    expect(screen.getByLabelText("Question")).toHaveValue("");
    await user.type(screen.getByLabelText("Question"), "Avoided refunds?");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(apiRequest).toHaveBeenCalledWith("/api/agents/agent-9/criteria", {
      method: "POST",
      body: JSON.stringify({
        question: "Avoided refunds?",
        passDescription: null,
        failDescription: "Promised a refund.",
        appliesWhen: null,
        failBelow: 0.2,
        passAbove: 0.8,
        sourceFixDraftId: "d1",
      }),
    });
  });

  it("truncates a long rationale to the description limit", async () => {
    const user = userEvent.setup();
    renderWorkspace("x".repeat(2500));

    await user.click(
      screen.getByRole("button", { name: "Turn into criterion" }),
    );

    expect(screen.getByLabelText("Fails when")).toHaveValue("x".repeat(2000));
  });
});

describe("RunWorkspace noting a fix from a verdict", () => {
  const messages = [
    { id: "in-0", role: "user", parts: [{ type: "text", text: "Refund me" }] },
    {
      id: "out-1",
      role: "assistant",
      parts: [{ type: "text", text: "first" }],
    },
    { id: "out-2", role: "user", parts: [{ type: "text", text: "and?" }] },
    { id: "out-3", role: "assistant", parts: [{ type: "text", text: "last" }] },
  ] as UIMessage[];

  const failing: RunEvaluationView = {
    id: "e1",
    criterionId: "c1",
    questionSnapshot: "Did it avoid promising a refund?",
    currentQuestion: "Did it avoid promising a refund?",
    criterionActive: true,
    status: "fail",
    pPass: 0.1,
    skipReason: null,
    error: null,
    reviewedVerdict: null,
  };

  function renderWithVerdict(overrides: Partial<RunWorkspaceProps> = {}) {
    render(
      <RunWorkspace
        agentId="agent-9"
        runId="run-7"
        source="dashboard"
        draftsEndpoint="/api/runs/run-7/fix-drafts"
        messages={messages}
        initialFixDrafts={[]}
        evaluations={[failing]}
        hasActiveCriteria
        hasTranscript
        {...overrides}
      />,
    );
  }

  it("anchors the note to the last assistant turn with the question prefilled in the rationale", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue({
      ...draft,
      id: "d2",
      messageId: "out-3",
    });
    renderWithVerdict();

    const row = screen
      .getByText("Did it avoid promising a refund?")
      .closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Note a fix" }));

    expect(screen.getByLabelText("Rationale")).toHaveValue(
      "Failed criterion: Did it avoid promising a refund?",
    );
    await user.type(screen.getByLabelText("Rationale"), " Always confirm.");
    await user.click(screen.getByRole("button", { name: "Save note" }));

    expect(apiRequest).toHaveBeenCalledWith("/api/runs/run-7/fix-drafts", {
      method: "POST",
      body: JSON.stringify({
        messageId: "out-3",
        anchor: { type: "turn" },
        category: "prompt",
        rationale:
          "Failed criterion: Did it avoid promising a refund? Always confirm.",
        proposedValue: null,
      }),
    });
  });

  it("words the prefilled rationale as unsure when the judge could not decide", async () => {
    const user = userEvent.setup();
    renderWithVerdict({
      evaluations: [{ ...failing, status: "needs_review", pPass: 0.5 }],
    });

    const row = screen
      .getByText("Did it avoid promising a refund?")
      .closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Note a fix" }));

    expect(screen.getByLabelText("Rationale")).toHaveValue(
      "Judge unsure on criterion: Did it avoid promising a refund?",
    );
  });

  it("switches to the fix drafts tab once the note is saved", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue({
      ...draft,
      id: "d2",
      messageId: "out-3",
    });
    renderWithVerdict();

    const row = screen
      .getByText("Did it avoid promising a refund?")
      .closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Note a fix" }));
    await user.click(screen.getByRole("button", { name: "Save note" }));

    expect(
      await screen.findByRole("tab", { name: /Fix drafts/, selected: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Turn into criterion" }),
    ).toBeInTheDocument();
  });

  it("offers no Note a fix on a verdict when the transcript has no assistant turn", () => {
    renderWithVerdict({ messages: [messages[0]] });

    const row = screen
      .getByText("Did it avoid promising a refund?")
      .closest("li") as HTMLElement;
    expect(
      within(row).queryByRole("button", { name: "Note a fix" }),
    ).not.toBeInTheDocument();
  });
});

describe("RunWorkspace sidebar", () => {
  const verdict = (
    overrides: Partial<RunEvaluationView> = {},
  ): RunEvaluationView => ({
    id: "e1",
    criterionId: "c1",
    questionSnapshot: "Did it confirm before refunding?",
    currentQuestion: "Did it confirm before refunding?",
    criterionActive: true,
    status: "needs_review",
    pPass: 0.5,
    skipReason: null,
    error: null,
    reviewedVerdict: null,
    ...overrides,
  });

  function renderSidebar(
    evaluations: RunEvaluationView[],
    initialFixDrafts: FixDraft[],
  ) {
    render(
      <RunWorkspace
        agentId="agent-9"
        runId="run-7"
        source="dashboard"
        draftsEndpoint="/api/runs/run-7/fix-drafts"
        messages={[]}
        initialFixDrafts={initialFixDrafts}
        evaluations={evaluations}
        hasActiveCriteria
        hasTranscript
      />,
    );
  }

  it("shows the run's counts in one compact summary", () => {
    renderSidebar([], []);

    const summary = screen.getByRole("region", { name: "Summary" });
    for (const label of ["Messages", "Tool calls", "Errors", "Denied"])
      expect(within(summary).getByText(label)).toBeInTheDocument();
  });

  it("opens on evaluation when a verdict needs review, counting what waits in each tab", () => {
    renderSidebar(
      [verdict(), verdict({ id: "e2", status: "fail", pPass: 0.1 })],
      [draft],
    );

    expect(
      screen.getByRole("tab", {
        name: "Evaluation 2 to review",
        selected: true,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Fix drafts 1 open" }),
    ).toBeInTheDocument();
  });

  it("opens on fix drafts when nothing needs review and a note is open", () => {
    renderSidebar(
      [
        verdict({ status: "pass", pPass: 0.9 }),
        verdict({ id: "e2", reviewedVerdict: "pass" }),
        verdict({ id: "e3", criterionActive: false }),
        verdict({ id: "e4", currentQuestion: "Reworded?" }),
      ],
      [draft],
    );

    expect(
      screen.getByRole("tab", { name: "Evaluation", selected: false }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Fix drafts 1 open", selected: true }),
    ).toBeInTheDocument();
  });

  it("opens on evaluation when nothing waits anywhere, and switches on click", async () => {
    const user = userEvent.setup();
    renderSidebar([], [{ ...draft, status: "applied" }]);

    expect(
      screen.getByRole("tab", { name: "Evaluation", selected: true }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Fix drafts" }));
    expect(
      screen.getByRole("tab", { name: "Fix drafts", selected: true }),
    ).toBeInTheDocument();
  });
});
