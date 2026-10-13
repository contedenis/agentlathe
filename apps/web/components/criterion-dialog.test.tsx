import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "@/lib/mutate";
import type { AgentCriterion } from "@/lib/queries";
import { CriterionDialog } from "./criterion-dialog";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));
vi.mock("@/lib/mutate", () => ({ apiRequest: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

const criterion: AgentCriterion = {
  id: "c1",
  question: "Did it confirm first?",
  passDescription: "Asks for confirmation.",
  failDescription: "Acts without asking.",
  appliesWhen: null,
  failBelow: 0.2,
  passAbove: 0.8,
  isActive: true,
  sourceFixDraftId: null,
  sourceRunId: null,
  stats: { pass: 0, fail: 0, needsReview: 0, passRate: null },
};

describe("CriterionDialog", () => {
  it("creates a criterion with trimmed text, the condition and the thresholds", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(undefined);
    const onOpenChange = vi.fn();

    render(<CriterionDialog agentId="a1" open onOpenChange={onOpenChange} />);

    await user.type(screen.getByLabelText("Question"), "  Did it confirm?  ");
    await user.type(screen.getByLabelText("Passes when"), "Asks first.");
    await user.type(screen.getByLabelText("Fails when"), "Acts at once.");
    await user.click(screen.getByRole("button", { name: "Add a condition" }));
    await user.type(
      screen.getByLabelText("Only evaluate when"),
      " Was a refund requested? ",
    );
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    await user.clear(screen.getByLabelText("Fail below"));
    await user.type(screen.getByLabelText("Fail below"), "0.1");
    await user.clear(screen.getByLabelText("Pass above"));
    await user.type(screen.getByLabelText("Pass above"), "0.9");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(apiRequest).toHaveBeenCalledWith("/api/agents/a1/criteria", {
      method: "POST",
      body: JSON.stringify({
        question: "Did it confirm?",
        passDescription: "Asks first.",
        failDescription: "Acts at once.",
        appliesWhen: "Was a refund requested?",
        failBelow: 0.1,
        passAbove: 0.9,
      }),
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(refresh).toHaveBeenCalled();
  });

  it("sends nulls for the optional fields left empty and default thresholds", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(undefined);

    render(<CriterionDialog agentId="a1" open onOpenChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    await user.type(screen.getByLabelText("Question"), "Did it work?");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(apiRequest).toHaveBeenCalledWith("/api/agents/a1/criteria", {
      method: "POST",
      body: JSON.stringify({
        question: "Did it work?",
        passDescription: null,
        failDescription: null,
        appliesWhen: null,
        failBelow: 0.2,
        passAbove: 0.8,
      }),
    });
  });

  it("patches the whole criterion when editing", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(undefined);

    render(
      <CriterionDialog
        agentId="a1"
        open
        onOpenChange={vi.fn()}
        criterion={criterion}
      />,
    );

    const question = screen.getByLabelText("Question");
    expect(question).toHaveValue("Did it confirm first?");
    await user.clear(question);
    await user.type(question, "Did it always confirm?");
    await user.clear(screen.getByLabelText("Fails when"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(apiRequest).toHaveBeenCalledWith("/api/agents/a1/criteria/c1", {
      method: "PATCH",
      body: JSON.stringify({
        question: "Did it always confirm?",
        passDescription: "Asks for confirmation.",
        failDescription: null,
        appliesWhen: null,
        failBelow: 0.2,
        passAbove: 0.8,
      }),
    });
  });

  it("shows the API error inline and stays open", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockRejectedValue(new Error("Agent not found."));
    const onOpenChange = vi.fn();

    render(<CriterionDialog agentId="a1" open onOpenChange={onOpenChange} />);

    await user.type(screen.getByLabelText("Question"), "Q?");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText("Agent not found.")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("blocks saving when Fail below is greater than Pass above", async () => {
    const user = userEvent.setup();

    render(<CriterionDialog agentId="a1" open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Question"), "Q?");
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    await user.clear(screen.getByLabelText("Fail below"));
    await user.type(screen.getByLabelText("Fail below"), "0.9");
    await user.clear(screen.getByLabelText("Pass above"));
    await user.type(screen.getByLabelText("Pass above"), "0.5");

    expect(
      screen.getByText(/“Fail below” can't be greater than “Pass above”/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    expect(
      screen.getByText(/“Fail below” can't be greater than “Pass above”/),
    ).toBeInTheDocument();
    const create = screen.getByRole("button", { name: "Create" });
    expect(create).toBeDisabled();
    await user.click(create);
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("notes that both descriptions work best only while exactly one is filled", async () => {
    const user = userEvent.setup();

    render(<CriterionDialog agentId="a1" open onOpenChange={vi.fn()} />);

    const note = /Both together work best/;
    expect(screen.queryByText(note)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Passes when"), "Good.");
    expect(screen.getByText(note)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Fails when"), "Bad.");
    expect(screen.queryByText(note)).not.toBeInTheDocument();
  });

  it("does not offer a run check when there is no origin run", async () => {
    const user = userEvent.setup();

    render(
      <CriterionDialog
        agentId="a1"
        open
        onOpenChange={vi.fn()}
        criterion={criterion}
      />,
    );

    await user.type(screen.getByLabelText("Question"), "?");
    expect(
      screen.queryByText(/the run this came from/),
    ).not.toBeInTheDocument();
    expect(apiRequest).not.toHaveBeenCalled();
  });
});

function fakeTimerUser() {
  return {
    type: async (element: HTMLElement, text: string) => {
      const input = element as HTMLInputElement;
      fireEvent.change(input, { target: { value: input.value + text } });
    },
    clear: async (element: HTMLElement) => {
      fireEvent.change(element, { target: { value: "" } });
    },
    click: async (element: HTMLElement) => {
      await act(async () => {
        fireEvent.click(element);
      });
    },
  };
}

const PREVIEW_URL = "/api/runs/r1/evaluate/preview";

function previewCalls() {
  return vi
    .mocked(apiRequest)
    .mock.calls.filter(([url]) => url === PREVIEW_URL);
}

function verdict(
  status: string,
  pPass: number | null,
  extra: Record<string, unknown> = {},
) {
  return {
    status,
    pPass,
    pApplies: null,
    skipReason: null,
    error: null,
    judgeModel: "typesafe/jev-1.13",
    ...extra,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("CriterionDialog promoted from a fix draft", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  function renderPromote() {
    const user = fakeTimerUser();
    const onOpenChange = vi.fn();
    render(
      <CriterionDialog
        agentId="a1"
        open
        onOpenChange={onOpenChange}
        prefill={{
          failDescription: "Promised a refund.",
          sourceFixDraftId: "d1",
        }}
        previewRunId="r1"
      />,
    );
    return { user, onOpenChange };
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("prefills Fails when and saves with the source draft id", async () => {
    vi.mocked(apiRequest).mockImplementation(async (url) =>
      url === PREVIEW_URL ? verdict("fail", 0.08) : undefined,
    );
    const { user, onOpenChange } = renderPromote();

    expect(screen.getByLabelText("Fails when")).toHaveValue(
      "Promised a refund.",
    );
    expect(screen.getByLabelText("Question")).toHaveValue("");
    await user.type(screen.getByLabelText("Question"), "Did it avoid refunds?");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(apiRequest).toHaveBeenCalledWith("/api/agents/a1/criteria", {
      method: "POST",
      body: JSON.stringify({
        question: "Did it avoid refunds?",
        passDescription: null,
        failDescription: "Promised a refund.",
        appliesWhen: null,
        failBelow: 0.2,
        passAbove: 0.8,
        sourceFixDraftId: "d1",
      }),
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("checks the current fields against the origin run after a debounce", async () => {
    vi.mocked(apiRequest).mockResolvedValue(verdict("fail", 0.08));
    const { user } = renderPromote();

    expect(
      screen.getByText(
        "Fill in the question to check it against the run this came from.",
      ),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText("Question"), "Avoided?");
    expect(previewCalls()).toHaveLength(0);
    expect(screen.getByText("Checking…")).toBeInTheDocument();

    await advance(799);
    expect(previewCalls()).toHaveLength(0);
    await advance(1);

    expect(previewCalls()).toHaveLength(1);
    const [, init] = previewCalls()[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      question: "Avoided?",
      passDescription: null,
      failDescription: "Promised a refund.",
      appliesWhen: null,
      failBelow: 0.2,
      passAbove: 0.8,
    });
  });

  it("collapses a burst of edits into one check with the latest values", async () => {
    vi.mocked(apiRequest).mockResolvedValue(verdict("fail", 0.1));
    const { user } = renderPromote();

    await user.type(screen.getByLabelText("Question"), "Ab");
    await advance(500);
    await user.type(screen.getByLabelText("Passes when"), "Fine.");
    await advance(800);

    expect(previewCalls()).toHaveLength(1);
    expect(JSON.parse(String(previewCalls()[0][1]?.body))).toMatchObject({
      question: "Ab",
      passDescription: "Fine.",
    });
  });

  it.each([
    [
      verdict("fail", 0.08),
      "On the run this came from: fails (0.08) — as expected.",
    ],
    [
      verdict("pass", 0.91),
      "On the run this came from: passes (0.91). The draft describes a failure, so the question may be phrased the wrong way round.",
    ],
    [
      verdict("needs_review", 0.5),
      "On the run this came from: the judge is unsure (0.50), so it would be flagged for review.",
    ],
    [
      verdict("not_applicable", null, { pApplies: 0.03 }),
      "On the run this came from: the condition does not hold (0.03), so the criterion would not apply.",
    ],
    [
      verdict("skipped", null, { skipReason: "too_long" }),
      "That run is too long for the judge to check.",
    ],
    [verdict("error", null, { error: "bad key" }), "The check failed: bad key"],
    [
      { skipped: "no_transcript" },
      "This run has no stored transcript, so it can't be checked.",
    ],
  ])("renders the check result %#", async (response, message) => {
    vi.mocked(apiRequest).mockResolvedValue(response);
    const { user } = renderPromote();

    await user.type(screen.getByLabelText("Question"), "Q?");
    await advance(800);

    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.queryByText("Checking…")).not.toBeInTheDocument();
  });

  it("shows a muted note when the check request itself fails", async () => {
    vi.mocked(apiRequest).mockRejectedValue(new Error("Run not found."));
    const { user } = renderPromote();

    await user.type(screen.getByLabelText("Question"), "Q?");
    await advance(800);

    expect(
      screen.getByText("Could not check: Run not found."),
    ).toBeInTheDocument();
  });

  it("ignores a stale response that arrives after a newer one", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    vi.mocked(apiRequest)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { user } = renderPromote();

    await user.type(screen.getByLabelText("Question"), "A");
    await advance(800);
    await user.type(screen.getByLabelText("Question"), "B");
    await advance(800);
    expect(previewCalls()).toHaveLength(2);

    await act(async () => {
      second.resolve(verdict("fail", 0.05));
    });
    expect(
      screen.getByText(/fails \(0\.05\) — as expected/),
    ).toBeInTheDocument();

    await act(async () => {
      first.resolve(verdict("pass", 0.95));
    });
    expect(
      screen.getByText(/fails \(0\.05\) — as expected/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/passes \(0\.95\)/)).not.toBeInTheDocument();
  });

  it("lets the user save while a check is still in flight", async () => {
    const pending = deferred<unknown>();
    vi.mocked(apiRequest).mockImplementation(async (url) =>
      url === PREVIEW_URL ? pending.promise : undefined,
    );
    const { user, onOpenChange } = renderPromote();

    await user.type(screen.getByLabelText("Question"), "Q?");
    await advance(800);
    expect(screen.getByText("Checking…")).toBeInTheDocument();

    const create = screen.getByRole("button", { name: "Create" });
    expect(create).toBeEnabled();
    await user.click(create);

    expect(apiRequest).toHaveBeenCalledWith(
      "/api/agents/a1/criteria",
      expect.objectContaining({ method: "POST" }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not check while the thresholds are out of order", async () => {
    vi.mocked(apiRequest).mockResolvedValue(verdict("fail", 0.1));
    const { user } = renderPromote();

    await user.type(screen.getByLabelText("Question"), "Q?");
    await advance(800);
    expect(previewCalls()).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Advanced" }));
    await user.clear(screen.getByLabelText("Fail below"));
    await user.type(screen.getByLabelText("Fail below"), "0.95");
    await advance(1000);

    expect(previewCalls()).toHaveLength(1);
    expect(
      screen.getByText(
        "Fix the thresholds to check this against the run it came from.",
      ),
    ).toBeInTheDocument();
  });
});

describe("CriterionDialog editing a promoted criterion", () => {
  it("keeps the check against the run the draft came from", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const user = fakeTimerUser();
    vi.mocked(apiRequest).mockResolvedValue(verdict("fail", 0.12));

    render(
      <CriterionDialog
        agentId="a1"
        open
        onOpenChange={vi.fn()}
        criterion={{ ...criterion, sourceFixDraftId: "d1", sourceRunId: "r9" }}
      />,
    );

    expect(
      screen.getByText(
        "Change a field to check it against the run this came from.",
      ),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText("Question"), "?");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    expect(apiRequest).toHaveBeenCalledWith(
      "/api/runs/r9/evaluate/preview",
      expect.objectContaining({ method: "POST" }),
    );
    expect(
      screen.getByText(/fails \(0\.12\) — as expected/),
    ).toBeInTheDocument();
  });
});
