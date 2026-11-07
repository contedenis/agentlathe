import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { apiRequest } from "@/lib/mutate";
import { ForgetSubjectButton } from "./forget-subject-button";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push }),
}));
vi.mock("@/lib/mutate", () => ({ apiRequest: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe("ForgetSubjectButton", () => {
  it("says what goes before forgetting, and posts the subject once confirmed", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue({});
    render(
      <ForgetSubjectButton
        subjectId="customer-123"
        footprint={{
          memories: 2,
          runs: 1,
          transcripts: 1,
          schedules: [{ id: "s1", name: "Follow-up" }],
        }}
        redirectTo="/runs"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Forget subject" }));
    expect(screen.getByText(/Its memory in 2 agents/)).toBeInTheDocument();
    expect(screen.getByText(/of its 1 run\./)).toBeInTheDocument();
    expect(
      screen.getByText(/1 schedule that acts for it: Follow-up/),
    ).toBeInTheDocument();
    expect(apiRequest).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Forget subject" }));
    expect(apiRequest).toHaveBeenCalledWith("/api/subjects/forget", {
      method: "POST",
      body: JSON.stringify({ subjectId: "customer-123" }),
    });
    expect(push).toHaveBeenCalledWith("/runs");
  });
});
