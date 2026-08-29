import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "@/lib/mutate";
import { ToolForm } from "./tool-form";

vi.mock("@/lib/mutate", () => ({ apiRequest: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/json-editor", () => ({
  JsonEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      data-testid="json-editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("ToolForm", () => {
  it("submits the create payload with the parsed schema and approval flag", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(undefined);
    const onSuccess = vi.fn();

    render(<ToolForm onSuccess={onSuccess} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText("Name"), "My Tool");
    await user.type(screen.getByLabelText("Description"), "Does a thing");
    await user.type(
      screen.getByLabelText("Endpoint"),
      "https://example.com/api/tool",
    );
    await user.click(screen.getByRole("switch"));
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(apiRequest).toHaveBeenCalledWith("/api/tools", {
      method: "POST",
      body: JSON.stringify({
        name: "My Tool",
        description: "Does a thing",
        endpoint: "https://example.com/api/tool",
        inputSchema: { type: "object", properties: {} },
        needsApproval: true,
      }),
    });
    expect(onSuccess).toHaveBeenCalled();
  });

  it("shows an inline error and sends no request when the input schema is invalid", async () => {
    const user = userEvent.setup();

    render(<ToolForm onSuccess={vi.fn()} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText("Name"), "My Tool");
    await user.type(screen.getByLabelText("Description"), "Does a thing");
    await user.type(
      screen.getByLabelText("Endpoint"),
      "https://example.com/api/tool",
    );
    fireEvent.change(screen.getByTestId("json-editor"), {
      target: { value: "{not json" },
    });
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText(/must be valid JSON/i)).toBeInTheDocument();
    expect(apiRequest).not.toHaveBeenCalled();
  });
});
