import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FixDraft } from "@/lib/fix-drafts";
import { FixDraftsPanel } from "./fix-drafts-panel";

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

describe("FixDraftsPanel", () => {
  it("hands the draft to onPromote from 'Turn into criterion'", async () => {
    const user = userEvent.setup();
    const onPromote = vi.fn();

    render(
      <FixDraftsPanel
        drafts={[draft]}
        messages={[]}
        onStatusChange={vi.fn()}
        onEdit={vi.fn()}
        onPromote={onPromote}
        onJumpTo={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Turn into criterion" }),
    );

    expect(onPromote).toHaveBeenCalledWith(draft);
  });
});
