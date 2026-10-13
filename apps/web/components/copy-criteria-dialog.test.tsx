import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "@/lib/mutate";
import type { CriteriaCopySource } from "@/lib/queries";
import { CopyCriteriaDialog } from "./copy-criteria-dialog";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));
vi.mock("@/lib/mutate", () => ({ apiRequest: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  vi.clearAllMocks();
});

const sources: CriteriaCopySource[] = [
  {
    agentId: "s1",
    agentName: "Support bot",
    criteria: [
      {
        id: "c1",
        question: "Did it confirm?",
        passDescription: "Asks first.",
        failDescription: "Acts at once.",
        appliesWhen: "A refund was requested?",
        failBelow: 0.1,
        passAbove: 0.9,
      },
      {
        id: "c2",
        question: "Was it polite?",
        passDescription: null,
        failDescription: null,
        appliesWhen: null,
        failBelow: 0.2,
        passAbove: 0.8,
      },
      {
        id: "c3",
        question: "Did it stay on topic?",
        passDescription: null,
        failDescription: null,
        appliesWhen: null,
        failBelow: 0.2,
        passAbove: 0.8,
      },
    ],
  },
];

describe("CopyCriteriaDialog", () => {
  it("lists every criterion checked and copies all of them as independent criteria", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(undefined);
    const onOpenChange = vi.fn();

    render(
      <CopyCriteriaDialog
        agentId="a1"
        open
        onOpenChange={onOpenChange}
        sources={sources}
      />,
    );

    for (const name of [
      "Did it confirm?",
      "Was it polite?",
      "Did it stay on topic?",
    ])
      expect(screen.getByRole("checkbox", { name })).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Copy 3 criteria" }));

    expect(apiRequest).toHaveBeenCalledTimes(3);
    expect(apiRequest).toHaveBeenNthCalledWith(1, "/api/agents/a1/criteria", {
      method: "POST",
      body: JSON.stringify({
        question: "Did it confirm?",
        passDescription: "Asks first.",
        failDescription: "Acts at once.",
        appliesWhen: "A refund was requested?",
        failBelow: 0.1,
        passAbove: 0.9,
      }),
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(refresh).toHaveBeenCalled();
  });

  it("posts only the checked criteria and never a source draft id", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(undefined);

    render(
      <CopyCriteriaDialog
        agentId="a1"
        open
        onOpenChange={vi.fn()}
        sources={sources}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Was it polite?" }));
    await user.click(screen.getByRole("button", { name: "Copy 2 criteria" }));

    const bodies = vi
      .mocked(apiRequest)
      .mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies.map((body) => body.question)).toEqual([
      "Did it confirm?",
      "Did it stay on topic?",
    ]);
    for (const body of bodies)
      expect(body).not.toHaveProperty("sourceFixDraftId");
  });

  it("disables copying when nothing is checked", async () => {
    const user = userEvent.setup();

    render(
      <CopyCriteriaDialog
        agentId="a1"
        open
        onOpenChange={vi.fn()}
        sources={[{ ...sources[0], criteria: [sources[0].criteria[1]] }]}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Was it polite?" }));
    expect(
      screen.getByRole("button", { name: "Copy 0 criteria" }),
    ).toBeDisabled();
  });

  it("sends the next copy only after the previous one resolved", async () => {
    const user = userEvent.setup();
    let finishFirst!: () => void;
    vi.mocked(apiRequest)
      .mockReturnValueOnce(
        new Promise<undefined>((resolve) => {
          finishFirst = () => resolve(undefined);
        }),
      )
      .mockResolvedValue(undefined);

    render(
      <CopyCriteriaDialog
        agentId="a1"
        open
        onOpenChange={vi.fn()}
        sources={sources}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Copy 3 criteria" }));
    expect(apiRequest).toHaveBeenCalledTimes(1);

    finishFirst();
    await vi.waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(3));
    const questions = vi
      .mocked(apiRequest)
      .mock.calls.map(([, init]) => JSON.parse(String(init?.body)).question);
    expect(questions).toEqual([
      "Did it confirm?",
      "Was it polite?",
      "Did it stay on topic?",
    ]);
  });

  it("unchecks what was copied after a failure so a retry never duplicates", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    const onOpenChange = vi.fn();

    render(
      <CopyCriteriaDialog
        agentId="a1"
        open
        onOpenChange={onOpenChange}
        sources={sources}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Copy 3 criteria" }));

    expect(
      await screen.findByText("Copied 1 of 3, then failed: boom"),
    ).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
    expect(
      screen.getByRole("checkbox", { name: "Did it confirm?" }),
    ).not.toBeChecked();

    vi.mocked(apiRequest).mockClear();
    await user.click(screen.getByRole("button", { name: "Copy 2 criteria" }));

    const questions = vi
      .mocked(apiRequest)
      .mock.calls.map(([, init]) => JSON.parse(String(init?.body)).question);
    expect(questions).toEqual(["Was it polite?", "Did it stay on topic?"]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("starts from a full selection again after switching the source agent", async () => {
    const user = userEvent.setup();
    const two: CriteriaCopySource[] = [
      sources[0],
      {
        agentId: "s2",
        agentName: "Billing bot",
        criteria: [
          {
            id: "c9",
            question: "Was the invoice right?",
            passDescription: null,
            failDescription: null,
            appliesWhen: null,
            failBelow: 0.2,
            passAbove: 0.8,
          },
        ],
      },
    ];

    render(
      <CopyCriteriaDialog
        agentId="a1"
        open
        onOpenChange={vi.fn()}
        sources={two}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Was it polite?" }));
    expect(
      screen.getByRole("button", { name: "Copy 2 criteria" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("combobox"));
    await user.click(
      await screen.findByRole("option", { name: "Billing bot" }),
    );
    expect(
      screen.getByRole("checkbox", { name: "Was the invoice right?" }),
    ).toBeChecked();

    await user.click(screen.getByRole("combobox"));
    await user.click(
      await screen.findByRole("option", { name: "Support bot" }),
    );
    expect(
      screen.getByRole("checkbox", { name: "Was it polite?" }),
    ).toBeChecked();
    expect(
      screen.getByRole("button", { name: "Copy 3 criteria" }),
    ).toBeInTheDocument();
  });
});
