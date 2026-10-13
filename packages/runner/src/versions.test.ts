import { describe, expect, it } from "vitest";
import { MAX_DEPTH } from "./context";
import type { SubAgentRow } from "./loaders";
import {
  type AgentConfig,
  agentConfigSnapshot,
  computeAgentVersion,
  hashSnapshot,
  maskUrl,
} from "./versions";

const baseConfig = (): AgentConfig => ({
  agent: { model: "test/model", systemPrompt: "Be terse.", maxSteps: 8 },
  skills: [
    { id: "s1", name: "Tone", description: "Voice", content: "Be kind." },
    { id: "s2", name: "Format", description: "Shape", content: "Use lists." },
  ],
  httpTools: [
    {
      name: "Weather",
      description: "Gets the weather",
      endpoint: "http://localhost/weather",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" }, days: { type: "number" } },
        required: ["city"],
      },
      needsApproval: false,
    },
    {
      name: "Deploy",
      description: "Deploys",
      endpoint:
        "https://bot:literal-token@hooks.example.com/deploy?api_key=k-123&region=eu",
      inputSchema: { type: "object" },
      needsApproval: true,
    },
  ],
  mcpServers: [
    {
      id: "m1",
      name: "GitHub",
      serverUrl: "http://localhost/mcp?token=mcp-secret",
      authConfig: { Authorization: "Bearer literal-secret" },
      toolNames: ["list_issues", "create_issue"],
      approvalToolNames: ["create_issue"],
    },
  ],
  subAgents: [
    {
      id: "c1",
      name: "Writer",
      slug: "writer",
      description: "Writes drafts",
    },
    {
      id: "c2",
      name: "Critic",
      slug: "critic",
      description: null,
    },
  ],
});

const hashOf = (config: AgentConfig) =>
  hashSnapshot(agentConfigSnapshot(config));

describe("agentConfigSnapshot / hashSnapshot", () => {
  it("is deterministic: the same config hashes the same", () => {
    expect(hashOf(baseConfig())).toBe(hashOf(baseConfig()));
    expect(hashOf(baseConfig())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("row order never changes the hash", () => {
    const config = baseConfig();
    const reordered: AgentConfig = {
      ...config,
      skills: [...config.skills].reverse(),
      httpTools: [...config.httpTools].reverse(),
      subAgents: [...config.subAgents].reverse(),
      mcpServers: config.mcpServers.map((server) => ({
        ...server,
        toolNames: [...server.toolNames].reverse(),
      })),
    };
    expect(hashOf(reordered)).toBe(hashOf(config));
  });

  it("object key order never changes the hash", () => {
    const config = baseConfig();
    config.httpTools[0].inputSchema = {
      required: ["city"],
      properties: { days: { type: "number" }, city: { type: "string" } },
      type: "object",
    };
    expect(hashOf(config)).toBe(hashOf(baseConfig()));
  });

  const changes: Array<[string, (config: AgentConfig) => void]> = [
    [
      "model",
      (c) => {
        c.agent.model = "other/model";
      },
    ],
    [
      "systemPrompt",
      (c) => {
        c.agent.systemPrompt = "Be verbose.";
      },
    ],
    [
      "maxSteps",
      (c) => {
        c.agent.maxSteps = 9;
      },
    ],
    [
      "skill name",
      (c) => {
        c.skills[0].name = "Voice";
      },
    ],
    [
      "skill description",
      (c) => {
        c.skills[0].description = "Other";
      },
    ],
    [
      "skill content",
      (c) => {
        c.skills[0].content = "Be blunt.";
      },
    ],
    [
      "a skill removed",
      (c) => {
        c.skills.pop();
      },
    ],
    [
      "tool name",
      (c) => {
        c.httpTools[0].name = "Forecast";
      },
    ],
    [
      "tool description",
      (c) => {
        c.httpTools[0].description = "Other";
      },
    ],
    [
      "tool endpoint",
      (c) => {
        c.httpTools[0].endpoint = "http://x/y";
      },
    ],
    [
      "tool inputSchema",
      (c) => {
        c.httpTools[0].inputSchema = { type: "string" };
      },
    ],
    [
      "tool needsApproval",
      (c) => {
        c.httpTools[0].needsApproval = true;
      },
    ],
    [
      "mcp server name",
      (c) => {
        c.mcpServers[0].name = "GH";
      },
    ],
    [
      "mcp serverUrl",
      (c) => {
        c.mcpServers[0].serverUrl = "http://x";
      },
    ],
    [
      "mcp toolNames",
      (c) => {
        c.mcpServers[0].toolNames.pop();
      },
    ],
    [
      "mcp approvalToolNames",
      (c) => {
        c.mcpServers[0].approvalToolNames = [];
      },
    ],
    [
      "sub-agent slug",
      (c) => {
        c.subAgents[0].slug = "author";
      },
    ],
    [
      "sub-agent description",
      (c) => {
        c.subAgents[0].description = "Edits";
      },
    ],
    [
      "the name of a sub-agent without description",
      (c) => {
        c.subAgents[1].name = "Reviewer";
      },
    ],
    [
      "the order of a nested schema array",
      (c) => {
        c.httpTools[0].inputSchema = {
          type: "object",
          properties: { city: { type: "string" }, days: { type: "number" } },
          required: ["city", "days"],
        };
      },
    ],
    [
      "the secret in a tool endpoint",
      (c) => {
        c.httpTools[1].endpoint =
          "https://bot:other-token@hooks.example.com/deploy?api_key=k-123";
      },
    ],
    [
      "the secret in an MCP server URL",
      (c) => {
        c.mcpServers[0].serverUrl = "http://localhost/mcp?token=other-token";
      },
    ],
  ];

  it("keeps the order of arrays nested in values", () => {
    const config = baseConfig();
    const schema = (required: string[]) => ({
      type: "object",
      properties: { a: { enum: ["x", "y"] }, b: {} },
      required,
    });
    config.httpTools[0].inputSchema = schema(["a", "b"]);
    const reordered = baseConfig();
    reordered.httpTools[0].inputSchema = schema(["b", "a"]);
    expect(hashOf(reordered)).not.toBe(hashOf(config));
  });

  it.each(changes)("changing %s changes the hash", (_label, change) => {
    const config = baseConfig();
    change(config);
    expect(hashOf(config)).not.toBe(hashOf(baseConfig()));
  });

  const ignored: Array<[string, (config: AgentConfig) => void]> = [
    [
      "skill id",
      (c) => {
        c.skills[0].id = "s9";
      },
    ],
    [
      "mcp server id",
      (c) => {
        c.mcpServers[0].id = "m9";
      },
    ],
    [
      "sub-agent id",
      (c) => {
        c.subAgents[0].id = "c9";
      },
    ],
    [
      "the name of a sub-agent with a description",
      (c) => {
        c.subAgents[0].name = "Author";
      },
    ],
    [
      "mcp authConfig",
      (c) => {
        c.mcpServers[0].authConfig = { Authorization: "Bearer x" };
      },
    ],
    [
      "agent identity and lifecycle fields",
      (c) => {
        Object.assign(c.agent, {
          id: "a9",
          name: "Renamed",
          slug: "renamed",
          description: "New description",
          isActive: false,
          recordTraffic: true,
          createdAt: new Date(0),
          updatedAt: new Date(),
        });
      },
    ],
  ];

  it.each(ignored)("changing %s does not change the hash", (_label, change) => {
    const config = baseConfig();
    change(config);
    expect(hashOf(config)).toBe(hashOf(baseConfig()));
  });

  it("never carries an MCP server's auth config", () => {
    const serialized = JSON.stringify(agentConfigSnapshot(baseConfig()));
    expect(serialized).not.toContain("literal-secret");
    expect(serialized).not.toContain("authConfig");
    expect(agentConfigSnapshot(baseConfig()).mcpServers[0]).toMatchObject({
      name: "GitHub",
      toolNames: ["create_issue", "list_issues"],
      approvalToolNames: ["create_issue"],
    });
  });

  it("never carries a credential embedded in a URL", () => {
    const serialized = JSON.stringify(agentConfigSnapshot(baseConfig()));
    for (const secret of ["bot", "literal-token", "k-123", "mcp-secret"])
      expect(serialized).not.toContain(secret);
  });

  it("treats a null system prompt like an empty one, as the runtime does", () => {
    const empty = baseConfig();
    empty.agent.systemPrompt = "";
    const missing = baseConfig();
    missing.agent.systemPrompt = null;
    expect(hashOf(missing)).toBe(hashOf(empty));
  });
});

describe("maskUrl", () => {
  const full =
    "https://bot:user-secret@hooks.example.com:8443/services/path-secret?api_key=query-secret#frag-secret";

  it("keeps only scheme and host readable and digests everything else", () => {
    const masked = maskUrl(full);
    expect(masked).toMatch(
      /^https:\/\/hooks\.example\.com:8443\/sha256:[0-9a-f]{12}$/,
    );
    for (const secret of [
      "user-secret",
      "path-secret",
      "query-secret",
      "frag-secret",
      "services",
      "api_key",
    ])
      expect(masked).not.toContain(secret);
  });

  it.each([
    ["userinfo", "user-secret", "user-other"],
    ["path", "path-secret", "path-other"],
    ["query", "query-secret", "query-other"],
    ["fragment", "frag-secret", "frag-other"],
  ])("a change in the %s changes the digest", (_part, from, to) => {
    expect(maskUrl(full.replace(from, to))).not.toBe(maskUrl(full));
  });

  it("leaves a bare scheme and host unchanged", () => {
    expect(maskUrl("http://localhost:8080")).toBe("http://localhost:8080");
    expect(maskUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("digests a string that is not an http URL as a whole", () => {
    expect(maskUrl("not a url secret")).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(maskUrl("ftp://user:pw@host/x")).toMatch(/^sha256:[0-9a-f]{12}$/);
  });
});

describe("computeAgentVersion", () => {
  const agentConfig = (
    systemPrompt: string,
    subAgents: SubAgentRow[] = [],
  ): AgentConfig => ({
    agent: { model: "test/model", systemPrompt, maxSteps: 5 },
    skills: [],
    httpTools: [],
    mcpServers: [],
    subAgents,
  });
  const ref = (id: string): SubAgentRow => ({
    id,
    name: id,
    slug: id,
    description: null,
  });

  function graph(
    edges: Record<string, string[]>,
    prompts = {} as Record<string, string>,
  ) {
    const loads: string[] = [];
    const load = async (id: string) => {
      loads.push(id);
      return agentConfig(
        prompts[id] ?? `I am ${id}.`,
        (edges[id] ?? []).map(ref),
      );
    };
    return { load, loads };
  }

  const chain = (length: number) =>
    Object.fromEntries(
      Array.from({ length }, (_, i) => [
        `a${i}`,
        i + 1 < length ? [`a${i + 1}`] : [],
      ]),
    );

  it("walks a complete graph once per agent, fast", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `a${i}`);
    const { load, loads } = graph(
      Object.fromEntries(
        ids.map((id) => [id, ids.filter((other) => other !== id)]),
      ),
    );

    const started = performance.now();
    const { snapshot } = await computeAgentVersion("a0", load);

    expect(performance.now() - started).toBeLessThan(500);
    expect(loads).toHaveLength(12);
    expect(new Set(loads).size).toBe(12);
    expect(snapshot.descendants).toHaveLength(11);
  });

  it("is deterministic and terminates on cycles", async () => {
    const edges = { a: ["b"], b: ["a", "c"], c: ["b"] };
    const first = await computeAgentVersion("a", graph(edges).load);
    const second = await computeAgentVersion("a", graph(edges).load);
    expect(second.hash).toBe(first.hash);
    expect(first.snapshot.descendants.map((d) => d.slug)).toEqual(["b", "c"]);
  });

  it("a change to any reachable descendant changes the root hash", async () => {
    const edges = chain(MAX_DEPTH + 1);
    const deepest = `a${MAX_DEPTH}`;
    const before = await computeAgentVersion("a0", graph(edges).load);
    const after = await computeAgentVersion(
      "a0",
      graph(edges, { [deepest]: "Changed." }).load,
    );
    expect(after.hash).not.toBe(before.hash);
  });

  it("a descendant beyond the runtime's depth limit does not change the root hash", async () => {
    const edges = chain(MAX_DEPTH + 2);
    const tooDeep = `a${MAX_DEPTH + 1}`;
    const before = graph(edges);
    const { hash } = await computeAgentVersion("a0", before.load);
    const after = await computeAgentVersion(
      "a0",
      graph(edges, { [tooDeep]: "Changed." }).load,
    );
    expect(after.hash).toBe(hash);
    expect(before.loads).not.toContain(tooDeep);
  });

  it("reaches a descendant through its shortest path", async () => {
    const edges = { ...chain(MAX_DEPTH + 2), a0: ["a1", `a${MAX_DEPTH + 1}`] };
    const tooDeepByChain = `a${MAX_DEPTH + 1}`;
    const before = await computeAgentVersion("a0", graph(edges).load);
    const after = await computeAgentVersion(
      "a0",
      graph(edges, { [tooDeepByChain]: "Changed." }).load,
    );
    expect(after.hash).not.toBe(before.hash);
  });
});
