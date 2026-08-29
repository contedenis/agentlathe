import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "@/lib/mutate";
import { McpServerForm } from "./mcp-server-form";

vi.mock("@/lib/mutate", () => ({ apiRequest: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  vi.clearAllMocks();
});
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

describe("McpServerForm", () => {
  it("submits the create payload with the parsed auth JSON", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(undefined);
    const onSuccess = vi.fn();

    render(<McpServerForm onSuccess={onSuccess} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText("Name"), "My Server");
    await user.type(
      screen.getByLabelText("Server URL"),
      "https://example.com/mcp",
    );
    fireEvent.change(screen.getByTestId("json-editor"), {
      target: { value: '{"headers":{"Authorization":"Bearer x"}}' },
    });
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(apiRequest).toHaveBeenCalledWith("/api/mcp-servers", {
      method: "POST",
      body: JSON.stringify({
        name: "My Server",
        serverUrl: "https://example.com/mcp",
        authConfig: { headers: { Authorization: "Bearer x" } },
      }),
    });
    expect(onSuccess).toHaveBeenCalled();
  });

  it("shows an inline error and sends no request when the auth JSON is invalid", async () => {
    const user = userEvent.setup();

    render(<McpServerForm onSuccess={vi.fn()} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText("Name"), "My Server");
    await user.type(
      screen.getByLabelText("Server URL"),
      "https://example.com/mcp",
    );
    fireEvent.change(screen.getByTestId("json-editor"), {
      target: { value: "{not json" },
    });
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText(/must be valid JSON/i)).toBeInTheDocument();
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("omits authConfig from the PATCH body when the auth editor is left empty", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(undefined);

    render(
      <McpServerForm
        initial={{
          id: "srv-1",
          name: "Existing",
          serverUrl: "https://x.test",
          hasAuth: true,
        }}
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(apiRequest).toHaveBeenCalledWith("/api/mcp-servers/srv-1", {
      method: "PATCH",
      body: JSON.stringify({
        name: "Existing",
        serverUrl: "https://x.test",
      }),
    });
  });

  it("renders the saved env var reference name as a hint", () => {
    render(
      <McpServerForm
        initial={{
          id: "srv-1",
          name: "Existing",
          serverUrl: "https://x.test",
          hasAuth: true,
          authRefs: { Authorization: "AGENTLATHE_SECRET_X" },
        }}
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText(/AGENTLATHE_SECRET_X/)).toBeInTheDocument();
  });
});
