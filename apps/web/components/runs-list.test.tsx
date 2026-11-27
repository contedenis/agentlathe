import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { parseRunsFilter } from "@/lib/runs-filter";
import { RunsList } from "./runs-list";

vi.mock("next/navigation", () => ({
  usePathname: () => "/runs",
  useRouter: () => ({ replace: vi.fn() }),
}));

type Props = React.ComponentProps<typeof RunsList>;
type Run = Props["runs"][number];

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "r1",
    source: "dashboard",
    status: "ok",
    durationMs: 1200,
    createdAt: new Date("2026-10-01T10:00:00Z"),
    subjectId: null,
    agentId: "a1",
    agentName: "Support",
    openDrafts: 0,
    evaluationTotal: 0,
    evaluationFailed: 0,
    evaluationNeedsReview: 0,
    evaluationClear: 0,
    evaluationPassed: 0,
    evaluationErrors: 0,
    evaluationSkipped: 0,
    ...overrides,
  };
}

function renderList(
  props: Partial<Props> = {},
  filter: Parameters<typeof parseRunsFilter>[0] = {},
) {
  return render(
    <RunsList
      runs={[makeRun()]}
      total={1}
      filter={parseRunsFilter(filter)}
      agentName={null}
      needsReviewTotal={0}
      page={1}
      pageSize={25}
      {...props}
    />,
  );
}

function evaluationCell(index = 0) {
  const row = screen.getAllByRole("row")[index + 1];
  return within(within(row).getAllByRole("cell")[4]);
}

describe("RunsList evaluation indicator", () => {
  it("shows nothing for a run without verdicts", () => {
    renderList();

    expect(evaluationCell().queryByText(/fail|review/)).toBeNull();
    expect(evaluationCell().queryByLabelText("No failures")).toBeNull();
  });

  it("shows a red badge for failures and an amber one for verdicts waiting for review", () => {
    renderList({
      runs: [
        makeRun({
          evaluationTotal: 4,
          evaluationFailed: 2,
          evaluationNeedsReview: 1,
          evaluationClear: 1,
        }),
      ],
    });

    expect(evaluationCell().getByText("2 fail")).toBeInTheDocument();
    expect(evaluationCell().getByText("1 to review")).toBeInTheDocument();
  });

  it("shows only the badges that apply", () => {
    renderList({
      runs: [
        makeRun({
          evaluationTotal: 2,
          evaluationNeedsReview: 1,
          evaluationClear: 1,
        }),
      ],
    });

    expect(evaluationCell().getByText("1 to review")).toBeInTheDocument();
    expect(evaluationCell().queryByText(/fail/)).toBeNull();
  });

  it("shows a check when every verdict is a pass or not applicable and at least one passed", () => {
    renderList({
      runs: [
        makeRun({
          evaluationTotal: 3,
          evaluationClear: 3,
          evaluationPassed: 1,
        }),
      ],
    });

    expect(evaluationCell().getByLabelText("No failures")).toBeInTheDocument();
  });

  it("shows a neutral n/a when no criterion applied", () => {
    renderList({
      runs: [makeRun({ evaluationTotal: 2, evaluationClear: 2 })],
    });

    expect(evaluationCell().getByText("n/a")).toBeInTheDocument();
    expect(evaluationCell().queryByLabelText("No failures")).toBeNull();
  });

  it("shows error and skipped badges instead of a check when the judge could not decide", () => {
    renderList({
      runs: [
        makeRun({
          evaluationTotal: 3,
          evaluationClear: 1,
          evaluationPassed: 1,
          evaluationErrors: 1,
          evaluationSkipped: 1,
        }),
      ],
    });

    expect(evaluationCell().getByText("error")).toBeInTheDocument();
    expect(evaluationCell().getByText("skipped")).toBeInTheDocument();
    expect(evaluationCell().queryByLabelText("No failures")).toBeNull();
  });

  it("lets a fail or a pending review supersede the error badge", () => {
    renderList({
      runs: [
        makeRun({
          evaluationTotal: 2,
          evaluationFailed: 1,
          evaluationErrors: 1,
        }),
      ],
    });

    expect(evaluationCell().getByText("1 fail")).toBeInTheDocument();
    expect(evaluationCell().queryByText("error")).toBeNull();
  });
});

describe("RunsList evaluation filter", () => {
  function filterLinks() {
    const group = screen.getByRole("group", { name: "Evaluation" });
    return within(group).getAllByRole("button");
  }

  it("links each filter through the evaluation param and resets the page", () => {
    renderList({ page: 3 }, { q: "sup", source: "v1" });

    expect(
      filterLinks().map((link) => [
        link.textContent,
        link.getAttribute("href"),
      ]),
    ).toEqual([
      ["All", "/runs?q=sup&source=v1"],
      ["Needs review", "/runs?q=sup&source=v1&evaluation=needs_review"],
      ["Failed a criterion", "/runs?q=sup&source=v1&evaluation=failed"],
      ["Not evaluated", "/runs?q=sup&source=v1&evaluation=not_evaluated"],
    ]);
  });

  it("keeps the evaluation filter in the source links and the pagination", () => {
    renderList(
      { total: 60, page: 2, runs: [makeRun()] },
      { evaluation: "failed" },
    );

    expect(screen.getByRole("button", { name: "Playground" })).toHaveAttribute(
      "href",
      "/runs?source=dashboard&evaluation=failed",
    );
    expect(screen.getByRole("button", { name: "Previous" })).toHaveAttribute(
      "href",
      "/runs?evaluation=failed",
    );
    expect(screen.getByRole("button", { name: "Next" })).toHaveAttribute(
      "href",
      "/runs?evaluation=failed&page=3",
    );
  });

  it("marks the active filter", () => {
    renderList({}, { evaluation: "needs_review" });

    const active = filterLinks().find((link) =>
      link.textContent?.startsWith("Needs review"),
    );
    expect(active).toHaveClass("bg-secondary");
  });

  it("shows how many runs wait for review next to the queue", () => {
    renderList({ needsReviewTotal: 7 });

    expect(
      screen.getByRole("button", { name: /^Needs review\s*7$/ }),
    ).toBeInTheDocument();
  });

  it("shows no count when nothing waits", () => {
    renderList({ needsReviewTotal: 0 });

    expect(
      screen.getByRole("button", { name: "Needs review" }),
    ).toBeInTheDocument();
  });

  it("says nothing is left to review on an empty review queue", () => {
    renderList({ runs: [], total: 0 }, { evaluation: "needs_review" });

    expect(screen.getByText("Nothing to review.")).toBeInTheDocument();
  });

  it("keeps the generic empty message for the other filters", () => {
    renderList({ runs: [], total: 0 }, { evaluation: "failed" });

    expect(screen.getByText("No runs match this filter.")).toBeInTheDocument();
  });
});

describe("RunsList subject", () => {
  it("links a run's subject to the runs filtered by it", () => {
    renderList({ runs: [makeRun({ subjectId: "user 42" })] });

    expect(screen.getByRole("link", { name: "user 42" })).toHaveAttribute(
      "href",
      "/runs?subject=user+42",
    );
  });

  it("shows the active subject filter with a link that clears it", () => {
    renderList({}, { subject: "user-42", source: "v1" });

    expect(
      screen.getByRole("button", { name: "Clear subject filter user-42" }),
    ).toHaveAttribute("href", "/runs?source=v1");
  });
});

describe("RunsList queue", () => {
  const AGENT = "0b6f6c0e-3c58-4b56-9d0a-0d8c1f5f2a11";

  it("filters to the runs that need attention, keeping the other filters", () => {
    renderList({}, { source: "v1" });

    expect(
      screen.getByRole("button", { name: "Needs attention" }),
    ).toHaveAttribute("href", "/runs?source=v1&attention=1");
  });

  it("shows the agent filter by name with a link that clears it", () => {
    renderList({ agentName: "Support" }, { agent: AGENT, attention: "1" });

    expect(
      screen.getByRole("button", { name: "Clear agent filter Support" }),
    ).toHaveAttribute("href", "/runs?attention=1");
  });

  it("opens a run carrying the queue it was opened from, without the page", () => {
    renderList({ page: 2, total: 60 }, { agent: AGENT, attention: "1" });

    expect(
      within(screen.getAllByRole("row")[1]).getAllByRole("link")[0],
    ).toHaveAttribute("href", `/runs/r1?agent=${AGENT}&attention=1`);
  });
});
