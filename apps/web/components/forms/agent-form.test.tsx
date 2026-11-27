import { DEFAULT_MEMORY_PURPOSES } from "@agentlathe/db/constants";
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
      aria-label={id === "model" ? "Model" : id}
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

describe("AgentForm draft", () => {
  it("starts a new agent from a draft and still creates it, with the draft's slug kept", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue({ id: "agent-9" });

    render(
      <AgentForm
        catalogs={emptyCatalogs}
        collections={[]}
        models={[]}
        contextFallback={128_000}
        draft={{
          name: "Refund desk",
          slug: "refunds",
          description: "Answers refund questions.",
          model: "vendor/model-a",
          systemPrompt: "You answer refund questions.",
          maxSteps: 12,
        }}
      />,
    );

    expect(screen.getByLabelText("Name")).toHaveValue("Refund desk");
    await user.click(screen.getByRole("button", { name: "Create" }));

    const [url, init] = vi.mocked(apiRequest).mock.calls[0];
    expect(url).toBe("/api/agents");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      name: "Refund desk",
      slug: "refunds",
      model: "vendor/model-a",
      systemPrompt: "You answer refund questions.",
      maxSteps: 12,
    });
  });
});

describe("AgentForm", () => {
  it("submits the create payload with tools, sub-agents and mcp tool selections wired", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue({ id: "agent-9" });

    render(
      <AgentForm
        catalogs={emptyCatalogs}
        collections={[]}
        models={[]}
        contextFallback={128_000}
      />,
    );

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

  it("sends the recording and evaluation switches, evaluating by default", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue({ id: "agent-9" });

    render(
      <AgentForm
        catalogs={emptyCatalogs}
        collections={[]}
        models={[]}
        contextFallback={128_000}
      />,
    );

    await user.type(screen.getByLabelText("Name"), "My Agent");
    await user.type(screen.getByLabelText("Model"), "openrouter/model");
    expect(
      screen.getByRole("switch", { name: "Evaluate new runs automatically" }),
    ).toBeChecked();
    await user.click(
      screen.getByRole("switch", { name: "Record external traffic" }),
    );
    await user.click(
      screen.getByRole("switch", { name: "Evaluate new runs automatically" }),
    );
    await user.click(screen.getByRole("button", { name: "Create" }));

    const body = JSON.parse(
      (vi.mocked(apiRequest).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).toMatchObject({ recordTraffic: true, autoEvaluate: false });
  });

  it("attaches collections to search, and warns when the collections read whole pass a quarter of the context", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue({ id: "agent-9" });
    render(
      <AgentForm
        catalogs={emptyCatalogs}
        collections={[
          {
            id: "c1",
            name: "Policies",
            description: "HR policies.",
            chars: 600_000,
          },
          { id: "c2", name: "Release notes", description: "", chars: 0 },
        ]}
        models={[]}
        contextFallback={128_000}
      />,
    );

    await user.type(screen.getByLabelText("Name"), "My Agent");
    await user.type(screen.getByLabelText("Model"), "openrouter/model");
    expect(
      screen.getByText(
        "No collections attached. The agent answers without documents.",
      ),
    ).toBeInTheDocument();
    await user.type(
      screen.getByRole("combobox", { name: "Add a collection" }),
      "pol{Enter}",
    );
    expect(apiRequest).not.toHaveBeenCalled();
    expect(
      screen.getByRole("combobox", { name: "Add a collection" }),
    ).toHaveAttribute("placeholder", "Add a collection (1 available)…");
    await user.click(screen.getByRole("button", { name: "Create" }));
    const body = JSON.parse(
      (vi.mocked(apiRequest).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.knowledge).toEqual([{ collectionId: "c1", mode: "search" }]);

    await user.click(
      screen.getByRole("combobox", { name: "How the agent uses Policies" }),
    );
    await user.click(
      await screen.findByRole("option", { name: "Always read" }),
    );
    expect(
      screen.getByText(/Read whole: about 150,000 tokens of the 32,000/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/runs search the collections that do not fit instead/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create" }));

    const second = JSON.parse(
      (vi.mocked(apiRequest).mock.calls[1][1] as RequestInit).body as string,
    );
    expect(second.knowledge).toEqual([{ collectionId: "c1", mode: "always" }]);

    await user.click(screen.getByRole("button", { name: "Remove Policies" }));
    await user.click(screen.getByRole("button", { name: "Create" }));
    const third = JSON.parse(
      (vi.mocked(apiRequest).mock.calls[2][1] as RequestInit).body as string,
    );
    expect(third.knowledge).toEqual([]);
  });

  it("gives the agent one memory, with the default settings", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue({ id: "agent-9" });
    render(
      <AgentForm
        catalogs={emptyCatalogs}
        collections={[]}
        models={[]}
        contextFallback={128_000}
      />,
    );

    await user.type(screen.getByLabelText("Name"), "My Agent");
    await user.type(screen.getByLabelText("Model"), "openrouter/model");
    await user.click(screen.getByRole("combobox", { name: "Memory" }));
    await user.click(
      await screen.findByRole("option", { name: "Agent memory per subject" }),
    );
    await user.click(screen.getByRole("button", { name: "Create" }));

    const body = JSON.parse(
      (vi.mocked(apiRequest).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.memory).toEqual({
      type: "agent_subject",
      settings: {
        purpose: DEFAULT_MEMORY_PURPOSES.agent_subject,
        charLimit: 8000,
        requireApproval: false,
      },
    });
  });

  it("asks for the x-memory-key value and a purpose for a memory with a custom key", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue({ id: "agent-9" });
    render(
      <AgentForm
        catalogs={emptyCatalogs}
        collections={[]}
        models={[]}
        contextFallback={128_000}
      />,
    );

    await user.type(screen.getByLabelText("Name"), "My Agent");
    await user.type(screen.getByLabelText("Model"), "openrouter/model");
    await user.click(screen.getByRole("combobox", { name: "Memory" }));
    await user.click(
      await screen.findByRole("option", {
        name: "Agent memory with a custom key",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(
      await screen.findByText("Set the x-memory-key value the agent expects."),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("x-memory-key"), " example-key ");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(
      await screen.findByText("A memory needs a purpose."),
    ).toBeInTheDocument();
    expect(apiRequest).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Purpose"), "Team decisions.");
    await user.click(screen.getByRole("button", { name: "Create" }));

    const body = JSON.parse(
      (vi.mocked(apiRequest).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.memory).toEqual({
      type: "custom",
      memoryKey: "example-key",
      settings: {
        purpose: "Team decisions.",
        charLimit: 8000,
        requireApproval: false,
      },
    });
  });

  it("rejects a slug with characters outside the allowed pattern before submitting", async () => {
    const user = userEvent.setup();

    render(
      <AgentForm
        catalogs={emptyCatalogs}
        collections={[]}
        models={[]}
        contextFallback={128_000}
      />,
    );

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
