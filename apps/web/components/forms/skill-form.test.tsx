import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "@/lib/mutate";
import { SkillForm } from "./skill-form";

vi.mock("@/lib/mutate", () => ({ apiRequest: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  vi.clearAllMocks();
});

describe("SkillForm", () => {
  it("submits the create payload with name, description and content", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(undefined);
    const onSuccess = vi.fn();

    render(<SkillForm onSuccess={onSuccess} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText("Name"), "My Skill");
    await user.type(
      screen.getByLabelText("Description"),
      "Injected into the prompt",
    );
    await user.type(screen.getByLabelText("Content"), "Full skill body");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(apiRequest).toHaveBeenCalledWith("/api/skills", {
      method: "POST",
      body: JSON.stringify({
        name: "My Skill",
        description: "Injected into the prompt",
        content: "Full skill body",
      }),
    });
    expect(onSuccess).toHaveBeenCalled();
  });
});
