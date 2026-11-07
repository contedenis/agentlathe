import { tool } from "ai";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@agentlathe/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@agentlathe/db")>()),
  db: { execute: vi.fn() },
}));
vi.mock("./knowledge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./knowledge")>()),
  loadKnowledge: vi.fn(),
}));
vi.mock("./memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./memory")>()),
  loadMemory: vi.fn(async () => ({ stores: [], seen: [], warnings: [] })),
}));
vi.mock("./loaders", () => ({
  loadAgentConfig: vi.fn(),
  loadKnowledgeCollections: vi.fn(async () => []),
  loadSkills: vi.fn(async () => []),
}));
vi.mock("./tools", () => ({ buildTools: vi.fn() }));
vi.mock("./helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./helpers")>()),
  buildProvider: vi.fn(),
  buildEmbeddingModel: vi.fn(),
  getContextLimit: vi.fn(async () => 128_000),
}));

import { db } from "@agentlathe/db";
import { generateWithApprovals } from "./generate-with-approvals";
import { buildEmbeddingModel, buildProvider } from "./helpers";
import { __resetPgvectorCache, loadKnowledge } from "./knowledge";
import type { AgentRow } from "./loaders";
import { buildTools } from "./tools";

const agent = {
  id: "agent-1",
  model: "openrouter/model",
  systemPrompt: "You answer HR questions.",
  maxSteps: 8,
} as AgentRow;

const usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

const textRound = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: "stop" as const,
  usage,
  warnings: [],
});

let callCount = 0;
const toolCallRound = (toolName: string, input: object) => ({
  content: [
    {
      type: "tool-call" as const,
      toolCallId: `call-${++callCount}`,
      toolName,
      input: JSON.stringify(input),
    },
  ],
  finishReason: "tool-calls" as const,
  usage,
  warnings: [],
});

const policies = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Policies",
  description: "Company HR policies.",
  mode: "search" as const,
};

const passage = {
  collection: "Policies",
  document: "handbook.pdf",
  page: 3,
  text: "Gifts over $250 must be politely declined.",
};

const scriptModel = (rounds: unknown[]) => {
  const model = new MockLanguageModelV4({ doGenerate: rounds as never });
  vi.mocked(buildProvider).mockReturnValue(model as never);
  return model;
};

const embedder = (fail = false) => {
  const model = new MockEmbeddingModelV4({
    doEmbed: async ({ values }) => {
      if (fail) throw new Error("embedding quota exceeded");
      return { embeddings: values.map(() => [1, 0, 0]), warnings: [] };
    },
  });
  vi.mocked(buildEmbeddingModel).mockReturnValue(model as never);
  return model;
};

const toolResults = (model: MockLanguageModelV4) =>
  (model.doGenerateCalls.at(-1)?.prompt ?? []).flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) =>
          part.type === "tool-result" ? [part.output] : [],
        )
      : [],
  );

const systemPrompt = (model: MockLanguageModelV4) =>
  model.doGenerateCalls[0]?.prompt.find((message) => message.role === "system")
    ?.content;

beforeEach(() => {
  vi.clearAllMocks();
  __resetPgvectorCache();
  callCount = 0;
  vi.mocked(buildTools).mockResolvedValue({
    tools: {},
    approvalToolNames: new Set(),
    toolKinds: new Map(),
    mcpFailures: [],
    cleanup: async () => {},
  });
  vi.mocked(loadKnowledge).mockResolvedValue({
    search: [policies],
    always: [],
    warnings: [],
  });
  vi.mocked(db.execute).mockImplementation((async (query: {
    queryChunks: unknown[];
  }) =>
    JSON.stringify(query).includes("to_regtype")
      ? { rows: [{ present: true }] }
      : { rows: [passage] }) as never);
});

describe("search_knowledge against the real SDK", () => {
  it("searches the agent's collections and hands the passages back as a knowledge call", async () => {
    const embeddings = embedder();
    const model = scriptModel([
      toolCallRound("search_knowledge", { query: "Can I keep a gift?" }),
      textRound("Decline gifts over $250."),
    ]);

    const { stats, text } = await generateWithApprovals(agent, "gift?");

    expect(text).toBe("Decline gifts over $250.");
    expect(embeddings.doEmbedCalls[0].values).toEqual(["Can I keep a gift?"]);
    const search = JSON.stringify(vi.mocked(db.execute).mock.calls.at(-1));
    expect(search).toContain(policies.id);
    expect(search).toContain("openai/text-embedding-3-small");
    expect(search).toContain("<=>");
    expect(toolResults(model)).toEqual([
      { type: "json", value: { passages: [passage] } },
    ]);
    expect(
      stats.calls.map((call) => [call.kind, call.name, call.status]),
    ).toEqual([["knowledge", "search_knowledge", "ok"]]);
    expect(systemPrompt(model)).toContain(
      "## Knowledge\n\nUse the `search_knowledge` tool",
    );
    expect(systemPrompt(model)).toContain("- Policies: Company HR policies.");
  });

  it("turns a provider failure into a tool error the model recovers from", async () => {
    embedder(true);
    const model = scriptModel([
      toolCallRound("search_knowledge", { query: "gift" }),
      textRound("I could not check the policies."),
    ]);

    const { stats, text } = await generateWithApprovals(agent, "gift?");

    expect(text).toBe("I could not check the policies.");
    expect(
      (toolResults(model)[0] as { type: string; value: string }).value,
    ).toContain("Knowledge search failed: embedding quota exceeded");
    expect(stats.calls.map((call) => [call.kind, call.status])).toEqual([
      ["knowledge", "error"],
    ]);
  });

  it("renames a user tool called search_knowledge and keeps its approval gate", async () => {
    embedder();
    const userTool = vi.fn(async () => "user tool ran");
    vi.mocked(buildTools).mockResolvedValue({
      tools: {
        search_knowledge: tool({
          description: "The user's own tool.",
          inputSchema: z.object({}),
          execute: userTool,
        }),
      },
      approvalToolNames: new Set(["search_knowledge"]),
      toolKinds: new Map([["search_knowledge", "tool"]]),
      mcpFailures: [],
      cleanup: async () => {},
    });
    const model = scriptModel([
      toolCallRound("search_knowledge_2", {}),
      textRound("asked"),
    ]);

    const { stats } = await generateWithApprovals(agent, "go", {
      askApproval: async () => false,
    });

    expect(userTool).not.toHaveBeenCalled();
    expect(model.doGenerateCalls[0].tools?.map((t) => t.name).sort()).toEqual([
      "load_skill",
      "search_knowledge",
      "search_knowledge_2",
    ]);
    expect(
      stats.calls.map((call) => [call.kind, call.name, call.status]),
    ).toEqual([["tool", "search_knowledge_2", "denied"]]);
  });

  it("offers no search tool to an agent that only reads its collections whole", async () => {
    vi.mocked(loadKnowledge).mockResolvedValue({
      search: [],
      always: [
        {
          ...policies,
          mode: "always",
          documents: [{ filename: "gifts.md", text: "Decline gifts." }],
        },
      ],
      warnings: [],
    });
    const model = scriptModel([textRound("Decline gifts.")]);

    await generateWithApprovals(agent, "gift?");

    expect(model.doGenerateCalls[0].tools?.map((t) => t.name)).toEqual([
      "load_skill",
    ]);
    expect(systemPrompt(model)).toContain(
      '<document collection="Policies" name="gifts.md">\nDecline gifts.\n</document>',
    );
  });
});
