import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_MEMORY_CONFIG } from "@/lib/memory-settings";
import { apiRequest } from "@/lib/mutate";
import { BuilderPanel, changedFields } from "./builder-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/mutate", () => ({ apiRequest: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/script-editor", () => ({
  ScriptEditor: ({ value }: { value: string }) => (
    <textarea aria-label="Script" readOnly value={value} />
  ),
}));
vi.mock("@/components/json-editor", () => ({
  JsonEditor: ({ value }: { value: string }) => (
    <textarea aria-label="Input schema" readOnly value={value} />
  ),
}));

function sseResponse(chunks: unknown[]): Response {
  const body =
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
    "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const proposal = {
  name: "Refund desk",
  description: "Answers refund questions.",
  model: "vendor/model-a",
  systemPrompt: "You answer refund questions.",
  skillIds: ["s1"],
  toolIds: ["t1", "t2"],
  subAgentIds: [],
  mcpTools: [],
  knowledge: [],
  memory: { type: "none" },
  rationale: "Two tools cover orders and refunds.",
  missing: ["A tool that issues the refund."],
};

const proposalStream = (state: "ok" | "rejected") => [
  { type: "start", messageId: "assistant-1" },
  { type: "start-step" },
  {
    type: "tool-input-available",
    toolCallId: "call-1",
    toolName: "propose_agent",
    input: proposal,
  },
  state === "ok"
    ? {
        type: "tool-output-available",
        toolCallId: "call-1",
        output: { presented: true },
      }
    : {
        type: "tool-output-error",
        toolCallId: "call-1",
        errorText: "The proposal cannot be loaded.",
      },
  { type: "finish-step" },
  { type: "finish", finishReason: "stop" },
];

const renderPanel = (
  props: Partial<Parameters<typeof BuilderPanel>[0]> = {},
) => {
  const onLoadAgent = vi.fn((_draft: unknown, _notes: unknown) => true);
  const onOpenChange = vi.fn();
  const { unmount } = render(
    <BuilderPanel
      open
      onOpenChange={onOpenChange}
      configured
      storageKey="builder:test"
      onLoadAgent={onLoadAgent}
      {...props}
    />,
  );
  return { onLoadAgent, onOpenChange, unmount };
};

const send = async (text: string) => {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Message to the builder"), text);
  await user.click(screen.getByRole("button", { name: "Send" }));
  return user;
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe("BuilderPanel", () => {
  it("shows a validated proposal as a card and loads it into the form as a draft", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(sseResponse(proposalStream("ok")));
    vi.stubGlobal("fetch", fetchMock);
    const { onLoadAgent, onOpenChange } = renderPanel();

    const user = await send("an agent for refunds");

    const card = await screen.findByRole("region", {
      name: "Proposed agent Refund desk",
    });
    expect(card).toHaveTextContent("1 skill · 2 HTTP tools");
    expect(card).toHaveTextContent("A tool that issues the refund.");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/builder/chat");

    await user.click(screen.getByRole("button", { name: "Load into form" }));

    expect(onLoadAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Refund desk",
        model: "vendor/model-a",
        skillIds: ["s1"],
        toolIds: ["t1", "t2"],
      }),
      [],
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows no card for a proposal the check rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sseResponse(proposalStream("rejected"))),
    );
    renderPanel();

    await send("an agent for refunds");

    await screen.findByText("an agent for refunds");
    expect(screen.queryByRole("button", { name: "Load into form" })).toBeNull();
  });

  it("keeps the conversation for the next time the panel opens, until a new one is started", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sseResponse(proposalStream("ok"))),
    );
    const first = renderPanel();
    await send("an agent for refunds");
    await screen.findByRole("button", { name: "Load into form" });
    first.unmount();

    renderPanel();

    const user = userEvent.setup();
    expect(
      await screen.findByRole("button", { name: "Load into form" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New conversation" }));
    expect(screen.queryByRole("button", { name: "Load into form" })).toBeNull();
  });

  it("asks for a builder model instead of a chat when none is configured", () => {
    renderPanel({ configured: false });

    expect(
      screen.getByRole("link", { name: "Choose a builder model in Settings" }),
    ).toHaveAttribute("href", "/settings");
    expect(screen.queryByLabelText("Message to the builder")).toBeNull();
  });
});

const toolStream = (toolName: string, input: unknown, output: unknown) => [
  { type: "start", messageId: "assistant-1" },
  { type: "start-step" },
  { type: "tool-input-available", toolCallId: "call-1", toolName, input },
  { type: "tool-output-available", toolCallId: "call-1", output },
  { type: "finish-step" },
  { type: "finish", finishReason: "stop" },
];

const current = {
  name: "Refund desk",
  slug: "refund-desk",
  description: "Answers refund questions.",
  model: "vendor/model-a",
  systemPrompt: "You answer refund questions.\nBe brief.",
  maxSteps: 20,
  recordTraffic: false,
  autoEvaluate: true,
  skillIds: ["s1"],
  toolIds: ["t1", "t2"],
  subAgentIds: [],
  mcpTools: [],
  knowledge: [],
  memory: EMPTY_MEMORY_CONFIG,
};
const agent = { id: "agent-1", name: "Refund desk", current };

describe("BuilderPanel on an existing agent", () => {
  it("sends the agent's id, shows what a change touches and hands the notes it answers to the form", async () => {
    const changes = {
      ...proposal,
      systemPrompt:
        "You answer refund questions.\nBe brief.\nNever promise a refund.",
      toolIds: ["t1"],
      addressedNotes: ["note-1"],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse(
        toolStream("propose_agent_changes", changes, {
          presented: true,
          notes: [{ id: "note-1", runId: "run-1" }],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { onLoadAgent } = renderPanel({ agent });

    const user = await send("improve it from the notes");

    const card = await screen.findByRole("region", {
      name: "Proposed changes Refund desk",
    });
    expect(card).toHaveTextContent(
      "Changes: system prompt (+1 −0 lines) · HTTP tools (+0 −1)",
    );
    expect(card).toHaveTextContent("Answers 1 open note.");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).agentId).toBe(
      "agent-1",
    );

    await user.click(screen.getByRole("button", { name: "Load into form" }));

    expect(onLoadAgent).toHaveBeenCalledWith(
      expect.objectContaining({ toolIds: ["t1"] }),
      [{ id: "note-1", runId: "run-1" }],
    );
    expect(onLoadAgent.mock.calls[0][0]).not.toHaveProperty("slug");
  });

  it("opens a proposed skill in the skill form, script included", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse(
          toolStream(
            "propose_skill",
            {
              name: "Date math",
              description: "Adds days to a date.",
              content: "Call the script.",
              script: "return input.days + 1;",
              inputSchemaJson: '{"type":"object"}',
              rationale: "Models get dates wrong.",
            },
            { presented: true },
          ),
        ),
      ),
    );
    vi.mocked(apiRequest).mockResolvedValue(undefined);
    renderPanel({ agent });

    const user = await send("a skill for dates");
    await user.click(
      await screen.findByRole("button", { name: "Open in form" }),
    );

    expect(await screen.findByLabelText("Name")).toHaveValue("Date math");
    expect(screen.getByLabelText("Script")).toHaveValue(
      "return input.days + 1;",
    );
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(
      JSON.parse(String(vi.mocked(apiRequest).mock.calls[0][1]?.body)),
    ).toEqual({
      name: "Date math",
      description: "Adds days to a date.",
      content: "Call the script.",
      script: "return input.days + 1;",
      inputSchema: { type: "object" },
      needsApproval: false,
    });
  });

  it("opens a proposed criterion and a proposed schedule in their forms", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse(
          toolStream(
            "propose_criterion",
            {
              question: "Did the agent avoid promising a refund?",
              failDescription: "It promised one.",
              appliesWhen: "Only when a refund is asked for.",
              rationale: "The main rule.",
            },
            { presented: true },
          ),
        ),
      )
      .mockResolvedValueOnce(
        sseResponse(
          toolStream(
            "propose_schedule",
            {
              name: "Morning digest",
              frequency: "weekdays",
              timeOfDay: "08:30",
              input: "Summarise yesterday's refunds.",
              rationale: "Daily summary.",
            },
            { presented: true },
          ).map((chunk) =>
            "messageId" in chunk
              ? { ...chunk, messageId: "assistant-2" }
              : chunk,
          ),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    renderPanel({ agent });

    const user = await send("a criterion");
    await user.click(
      await screen.findByRole("button", { name: "Open in form" }),
    );
    expect(
      await screen.findByDisplayValue("It promised one."),
    ).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("Only when a refund is asked for."),
    ).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("Did the agent avoid promising a refund?"),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await send("a schedule");
    const buttons = await screen.findAllByRole("button", {
      name: "Open in form",
    });
    await vi.waitFor(async () =>
      expect(
        (await screen.findAllByRole("button", { name: "Open in form" })).length,
      ).toBe(2),
    );
    await user.click(
      (await screen.findAllByRole("button", { name: "Open in form" })).at(-1) ??
        buttons[0],
    );
    expect(
      await screen.findByDisplayValue("Morning digest"),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("08:30")).toBeInTheDocument();
  });
});

describe("changedFields", () => {
  it("names only what differs, and nothing for an identical configuration", () => {
    expect(changedFields(current, { ...current })).toEqual([]);
    expect(
      changedFields(current, {
        ...current,
        model: "vendor/model-b",
        skillIds: [],
        memory: { ...EMPTY_MEMORY_CONFIG, type: "agent" },
      }),
    ).toEqual([
      "model vendor/model-a → vendor/model-b",
      "skills (+0 −1)",
      "memory none → agent",
    ]);
  });

  it("says when a tool loses its approval, and when only a memory key or setting moves", () => {
    const gated = {
      ...current,
      mcpTools: [{ serverId: "m1", toolName: "deploy", needsApproval: true }],
      memory: {
        ...EMPTY_MEMORY_CONFIG,
        type: "custom" as const,
        memoryKey: "a",
      },
    };

    expect(
      changedFields(gated, {
        ...gated,
        mcpTools: [
          { serverId: "m1", toolName: "deploy", needsApproval: false },
        ],
        memory: { ...gated.memory, memoryKey: "b" },
      }),
    ).toEqual(["MCP tools", "approval removed from deploy", "memory settings"]);
  });

  it("does not count a reordered list as a change", () => {
    expect(
      changedFields(current, { ...current, toolIds: ["t2", "t1"] }),
    ).toEqual([]);
  });
});
