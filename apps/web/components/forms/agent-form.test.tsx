import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "@/lib/mutate";
import { AgentForm } from "./agent-form";
import type { McpToolSelection, ToolPickerCatalogs } from "./tool-picker";

const push = vi.fn();
const back = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, back }),
}));
vi.mock("ai-tokenizer", () => ({
  models: {},
  Tokenizer: class {
    count(text: string) {
      return text.length;
    }
  },
}));
vi.mock("ai-tokenizer/encoding/o200k_base", () => ({}));
vi.mock("@/lib/mutate", () => ({ apiRequest: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/forms/model-combobox", () => ({
  ModelCombobox: ({
    id,
    value,
    onChange,
  }: {
    id?: string;
    value: string;
    onChange: (value: string) => void;
  }) => (
    <input
      id={id}
      aria-label="Model"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
vi.mock("@/components/forms/tool-picker", () => ({
  ToolPicker: ({
    toolIds,
    onToolIdsChange,
    subAgentIds,
    onSubAgentIdsChange,
    mcpTools,
    onMcpToolsChange,
  }: {
    toolIds: string[];
    onToolIdsChange: (ids: string[]) => void;
    subAgentIds: string[];
    onSubAgentIdsChange: (ids: string[]) => void;
    mcpTools: McpToolSelection[];
    onMcpToolsChange: (tools: McpToolSelection[]) => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() => onToolIdsChange([...toolIds, "tool-1"])}
      >
        Add HTTP tool
      </button>
      <button
        type="button"
        onClick={() => onSubAgentIdsChange([...subAgentIds, "agent-2"])}
      >
        Add sub-agent
      </button>
      <button
        type="button"
        onClick={() =>
          onMcpToolsChange([
            ...mcpTools,
            { serverId: "mcp-1", toolName: "search", needsApproval: true },
          ])
        }
      >
        Add MCP tool
      </button>
    </div>
  ),
}));

const emptyCatalogs: ToolPickerCatalogs = {
  skills: [],
  tools: [],
  mcpServers: [],
  subAgentCandidates: [],
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("AgentForm", () => {
  it("submits the create payload with tools, sub-agents and mcp tool selections wired", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue({ id: "agent-9" });

    render(<AgentForm catalogs={emptyCatalogs} models={[]} />);

    await user.type(screen.getByLabelText("Name"), "My Agent");
    await user.type(screen.getByLabelText("Model"), "openrouter/model");
    await user.click(screen.getByRole("button", { name: "Add HTTP tool" }));
    await user.click(screen.getByRole("button", { name: "Add sub-agent" }));
    await user.click(screen.getByRole("button", { name: "Add MCP tool" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(apiRequest).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(apiRequest).mock.calls[0];
    expect(url).toBe("/api/agents");
    expect(init).toMatchObject({ method: "POST" });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      name: "My Agent",
      slug: "my-agent",
      model: "openrouter/model",
      toolIds: ["tool-1"],
      subAgentIds: ["agent-2"],
      mcpTools: [
        { serverId: "mcp-1", toolName: "search", needsApproval: true },
      ],
    });
    expect(push).toHaveBeenCalledWith("/agents/agent-9");
  });

  it("rejects a slug with characters outside the allowed pattern before submitting", async () => {
    const user = userEvent.setup();

    render(<AgentForm catalogs={emptyCatalogs} models={[]} />);

    await user.type(screen.getByLabelText("Name"), "My Agent");
    await user.type(screen.getByLabelText("Model"), "openrouter/model");
    const slugInput = screen.getByLabelText(/^ID/);
    await user.clear(slugInput);
    await user.type(slugInput, "Not A Slug!");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(
      await screen.findByText(/may only contain lowercase letters/i),
    ).toBeInTheDocument();
    expect(apiRequest).not.toHaveBeenCalled();
  });
});
