import { describe, expect, it } from "vitest";

import type { BuilderCatalog } from "./catalog";
import { checkAgentProposal, type ProposalContext } from "./check";
import { type AgentProposal, proposalToDraft } from "./proposal";

const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

const catalog: BuilderCatalog = {
  skills: [
    { id: ID(1), name: "Tone", description: "Voice", runsScript: false },
  ],
  httpTools: [
    {
      id: ID(2),
      name: "Lookup order",
      description: "Finds an order",
      inputSchema: { type: "object" },
      needsApproval: false,
    },
  ],
  mcpServers: [{ id: ID(3), name: "GitHub" }],
  agents: [
    {
      id: ID(4),
      name: "Writer",
      slug: "writer",
      description: "Writes replies",
    },
  ],
  knowledge: [{ id: ID(5), name: "Handbook", description: "HR", chars: 1200 }],
};

const context = (
  overrides: Partial<ProposalContext> = {},
): ProposalContext => ({
  catalog,
  takenNames: new Set(["Writer"]),
  takenSlugs: new Set(["writer"]),
  modelIds: new Set(["vendor/model-a"]),
  mcpToolsOf: async () => new Set(["list_issues"]),
  ...overrides,
});

const proposal = (overrides: Partial<AgentProposal> = {}): AgentProposal => ({
  name: "Support triage",
  description: "Sorts tickets.",
  model: "vendor/model-a",
  systemPrompt: "You sort tickets.",
  skillIds: [ID(1)],
  toolIds: [ID(2)],
  subAgentIds: [ID(4)],
  mcpTools: [
    { serverId: ID(3), toolName: "list_issues", needsApproval: false },
  ],
  knowledge: [{ collectionId: ID(5), mode: "search" }],
  memory: { type: "agent_subject", purpose: "What each customer prefers." },
  rationale: "Because.",
  missing: [],
  ...overrides,
});

describe("checkAgentProposal", () => {
  it("accepts a proposal built only from the catalog", async () => {
    await expect(checkAgentProposal(proposal(), context())).resolves.toEqual(
      [],
    );
  });

  it("names every reference that is not in the catalog", async () => {
    const problems = await checkAgentProposal(
      proposal({
        skillIds: [ID(9)],
        toolIds: ["made-up"],
        knowledge: [{ collectionId: ID(8), mode: "always" }],
      }),
      context(),
    );

    expect(problems).toEqual(
      expect.arrayContaining([
        `skillIds: "${ID(9)}" is not an id from the catalog.`,
        'toolIds: "made-up" is not an id from the catalog.',
        `knowledge: "${ID(8)}" is not an id from the catalog.`,
      ]),
    );
  });

  it("refuses a taken name or ID, a model the provider does not serve and an MCP tool the server does not offer", async () => {
    const problems = await checkAgentProposal(
      proposal({
        name: "Writer",
        model: "vendor/unknown",
        mcpTools: [
          { serverId: ID(3), toolName: "delete_repo", needsApproval: true },
        ],
      }),
      context(),
    );

    expect(problems).toEqual([
      'An agent named "Writer" already exists.',
      'The ID "writer" is taken; pick another slug.',
      '"vendor/unknown" is not a model of this instance\'s provider; use search_models.',
      `mcpTools: the server ${ID(3)} offers no tool named "delete_repo"; use list_mcp_tools.`,
    ]);
  });

  it("does not judge models or MCP tools it cannot look up", async () => {
    const problems = await checkAgentProposal(
      proposal({ model: "local/llama" }),
      context({ modelIds: new Set(), mcpToolsOf: async () => null }),
    );

    expect(problems).toEqual([]);
  });

  it("applies the rules of the agent API: a memory needs a purpose and a custom one its key, a slug its shape", async () => {
    const problems = await checkAgentProposal(
      proposal({
        slug: "Not A Slug",
        memory: { type: "custom", purpose: "Notes." },
      }),
      context(),
    );

    expect(problems).toContain("Set the x-memory-key value the agent expects.");

    const slugProblems = await checkAgentProposal(
      proposal({ slug: "Not A Slug" }),
      context(),
    );
    expect(slugProblems.some((problem) => problem.startsWith("slug:"))).toBe(
      true,
    );
  });
});

describe("checkAgentProposal on an existing agent", () => {
  it("keeps what the agent already has attached, even if it is no longer in the catalog", async () => {
    const problems = await checkAgentProposal(
      proposal({ skillIds: [ID(1), ID(7)], toolIds: [ID(8)] }),
      context({ attached: new Set([ID(7)]) }),
    );

    expect(problems).toEqual([
      `toolIds: "${ID(8)}" is not an id from the catalog.`,
    ]);
  });
});

describe("proposalToDraft", () => {
  it("turns a proposal into the agent form's values", () => {
    const draft = proposalToDraft(proposal({ maxSteps: 12 }));

    expect(draft).toMatchObject({
      name: "Support triage",
      model: "vendor/model-a",
      maxSteps: 12,
      skillIds: [ID(1)],
      knowledge: [{ collectionId: ID(5), mode: "search" }],
    });
    expect(draft).not.toHaveProperty("slug");
    expect(draft.memory).toMatchObject({
      type: "agent_subject",
      settings: {
        agent_subject: {
          purpose: "What each customer prefers.",
          charLimit: "8000",
          requireApproval: false,
        },
      },
    });
  });

  it("keeps the agent's own limit, key and approval when a change does not set them, and drops duplicates", () => {
    const base = proposalToDraft(
      proposal({
        memory: { type: "custom", purpose: "Old.", memoryKey: "team-a" },
      }),
    ).memory;
    if (!base) throw new Error("no memory");
    const current = {
      ...base,
      settings: {
        ...base.settings,
        custom: { purpose: "Old.", charLimit: "3000", requireApproval: true },
      },
    };

    const draft = proposalToDraft(
      proposal({
        skillIds: [ID(1), ID(1)],
        memory: { type: "custom", purpose: "New." },
      }),
      current,
    );

    expect(draft.skillIds).toEqual([ID(1)]);
    expect(draft.memory).toMatchObject({
      type: "custom",
      memoryKey: "team-a",
      settings: {
        custom: { purpose: "New.", charLimit: "3000", requireApproval: true },
      },
    });
  });

  it("leaves memory off when the proposal has none", () => {
    expect(
      proposalToDraft(proposal({ memory: { type: "none" } })).memory,
    ).toMatchObject({ type: "none" });
  });
});
