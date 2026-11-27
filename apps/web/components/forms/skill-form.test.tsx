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
        script: null,
        inputSchema: null,
        needsApproval: false,
      }),
    });
    expect(onSuccess).toHaveBeenCalled();
  });

  it("saves a script with its input schema and approval, and offers them only when there is a script", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(undefined);

    const { unmount } = render(
      <SkillForm onSuccess={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.queryByText("Test run")).toBeNull();
    unmount();

    render(
      <SkillForm
        initial={{
          id: "s1",
          name: "Date math",
          description: "Adds days",
          content: "Use the script.",
          script: "return input.days + 1;",
          inputSchema: { type: "object" },
          needsApproval: false,
        }}
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole("switch", { name: "Requires approval before running" }),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(apiRequest).toHaveBeenCalledWith("/api/skills/s1", {
      method: "PATCH",
      body: JSON.stringify({
        name: "Date math",
        description: "Adds days",
        content: "Use the script.",
        script: "return input.days + 1;",
        inputSchema: { type: "object" },
        needsApproval: true,
      }),
    });
  });

  it("runs the script with the test input and shows what it returned, or why it failed", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest)
      .mockResolvedValueOnce({
        ok: true,
        result: { total: 3 },
        logs: ["adding"],
        durationMs: 12,
      })
      .mockResolvedValueOnce({
        ok: false,
        error: "The script ran out of time.",
        logs: [],
        durationMs: 2000,
      });

    render(
      <SkillForm
        draft={{
          name: "Sum",
          description: "Adds",
          content: "Use the script.",
          script: "return { total: input.a + input.b };",
        }}
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await user.clear(screen.getByLabelText("Test run"));
    await user.type(screen.getByLabelText("Test run"), '{{"a":1,"b":2}');
    await user.click(screen.getByRole("button", { name: "Run script" }));

    expect(apiRequest).toHaveBeenCalledWith("/api/skills/test-run", {
      method: "POST",
      body: JSON.stringify({
        script: "return { total: input.a + input.b };",
        input: { a: 1, b: 2 },
      }),
    });
    expect(await screen.findByText("Returned in 12 ms")).toBeInTheDocument();
    expect(screen.getByText(/"total": 3/)).toBeInTheDocument();
    expect(screen.getByText("adding")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Run script" }));

    expect(await screen.findByText("Failed in 2000 ms")).toBeInTheDocument();
    expect(screen.getByText("The script ran out of time.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
  });
});
