import { describe, expect, it } from "vitest";
import {
  diffText,
  diffVersions,
  readSnapshot,
  type VersionSnapshot,
} from "./version-diff";

const base: VersionSnapshot = {
  model: "openrouter/model-a",
  systemPrompt: "You help with orders.\nBe concise.\nNever promise refunds.",
  maxSteps: 10,
  skills: [
    { name: "Support tone", description: "How to talk", content: "Be kind." },
  ],
  httpTools: [
    {
      name: "Lookup order",
      description: "Finds an order",
      endpoint: "https://api.example.com/sha256:aaaaaaaaaaaa",
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
      needsApproval: false,
    },
  ],
  mcpServers: [
    {
      name: "GitHub",
      serverUrl: "https://mcp.example.com",
      toolNames: ["search_issues"],
      approvalToolNames: [],
    },
  ],
  subAgents: [{ slug: "writer", description: "Writes replies" }],
  descendants: [{ slug: "writer", hash: "h1" }],
};

const edit = (changes: Partial<VersionSnapshot>): VersionSnapshot => ({
  ...base,
  ...changes,
});

describe("diffText — line diffs with context", () => {
  it("returns no hunks for equal text", () => {
    expect(diffText("a\nb", "a\nb")).toEqual([]);
  });

  it("marks removed and added lines, keeping context around them", () => {
    expect(diffText("one\ntwo\nthree", "one\n2\nthree\nfour")).toEqual([
      [
        { kind: "context", text: "one" },
        { kind: "removed", text: "two" },
        { kind: "added", text: "2" },
        { kind: "context", text: "three" },
        { kind: "added", text: "four" },
      ],
    ]);
  });

  it("treats a missing trailing newline as no change", () => {
    expect(diffText("a\nb", "a\nb\n")).toEqual([]);
  });

  it("splits distant edits into separate hunks", () => {
    const from = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const to = from.replace("line 1\n", "LINE 1\n").replace("line 18", "x");
    expect(diffText(from, to)).toHaveLength(2);
  });
});

describe("diffVersions — what changed between two agent versions", () => {
  it("reports agent fields and summarizes them first", () => {
    const changes = diffVersions(
      base,
      edit({
        model: "openrouter/model-b",
        maxSteps: 20,
        systemPrompt: base.systemPrompt.replace("Be concise.", "Be brief."),
      }),
    );

    expect(changes.agent).toEqual([
      {
        label: "Model",
        kind: "value",
        from: "openrouter/model-a",
        to: "openrouter/model-b",
      },
      { label: "Max steps", kind: "value", from: "10", to: "20" },
      {
        label: "System prompt",
        kind: "text",
        hunks: [
          [
            { kind: "context", text: "You help with orders." },
            { kind: "removed", text: "Be concise." },
            { kind: "added", text: "Be brief." },
            { kind: "context", text: "Never promise refunds." },
          ],
        ],
      },
    ]);
    expect(changes.entities).toEqual([]);
    expect(changes.summary).toBe("prompt edited · model · max steps");
  });

  it("reports added, removed and edited entities by name", () => {
    const changes = diffVersions(
      base,
      edit({
        skills: [
          {
            name: "Support tone",
            description: "How to talk",
            content: "Be warm.",
          },
          {
            name: "Refunds",
            description: "Refund policy",
            content: "Ask first.",
          },
        ],
        httpTools: [],
      }),
    );

    expect(
      changes.entities.map(({ kind, name, status }) => [kind, name, status]),
    ).toEqual([
      ["skill", "Refunds", "added"],
      ["skill", "Support tone", "changed"],
      ["tool", "Lookup order", "removed"],
    ]);
    const edited = changes.entities.find((e) => e.name === "Support tone");
    expect(edited?.fields).toEqual([
      {
        label: "Content",
        kind: "text",
        hunks: [
          [
            { kind: "removed", text: "Be kind." },
            { kind: "added", text: "Be warm." },
          ],
        ],
      },
    ]);
    expect(changes.summary).toBe("+1 skill · 1 skill edited · −1 tool");
  });

  it("shows every field of an added entity against nothing", () => {
    const changes = diffVersions(edit({ httpTools: [] }), base);
    const [added] = changes.entities;
    expect(added).toMatchObject({ kind: "tool", status: "added" });
    expect(added.fields.map((field) => field.label)).toEqual([
      "Description",
      "Endpoint",
      "Input schema",
      "Requires approval",
    ]);
    expect(added.fields[3]).toEqual({
      label: "Requires approval",
      kind: "value",
      from: null,
      to: "no",
    });
  });

  it("diffs tool schemas as formatted JSON and approval as yes/no", () => {
    const [tool] = base.httpTools;
    const changes = diffVersions(
      base,
      edit({
        httpTools: [
          {
            ...tool,
            needsApproval: true,
            inputSchema: {
              type: "object",
              properties: { id: { type: "number" } },
            },
          },
        ],
      }),
    );
    const fields = changes.entities[0].fields;
    expect(fields.map((field) => field.label)).toEqual([
      "Input schema",
      "Requires approval",
    ]);
    expect(fields[0]).toMatchObject({ kind: "text" });
    expect(JSON.stringify(fields[0])).toContain('\\"type\\": \\"number\\"');
    expect(fields[1]).toEqual({
      label: "Requires approval",
      kind: "value",
      from: "no",
      to: "yes",
    });
    expect(changes.summary).toBe("1 tool edited");
  });

  it("lists MCP tool selection changes line by line", () => {
    const [server] = base.mcpServers;
    const changes = diffVersions(
      base,
      edit({
        mcpServers: [
          {
            ...server,
            toolNames: ["create_issue", "search_issues"],
            approvalToolNames: ["create_issue"],
          },
        ],
      }),
    );
    const [entity] = changes.entities;
    expect(entity).toMatchObject({
      kind: "mcp",
      name: "GitHub",
      status: "changed",
    });
    expect(entity.fields[0]).toEqual({
      label: "Selected tools",
      kind: "text",
      hunks: [
        [
          { kind: "added", text: "create_issue" },
          { kind: "context", text: "search_issues" },
        ],
      ],
    });
    expect(changes.summary).toBe("1 MCP server edited");
  });

  it("notes a sub-agent whose own configuration changed, direct or not", () => {
    const changes = diffVersions(
      edit({
        descendants: [
          { slug: "deep", hash: "d1" },
          { slug: "writer", hash: "h1" },
        ],
      }),
      edit({
        descendants: [
          { slug: "deep", hash: "d2" },
          { slug: "writer", hash: "h2" },
        ],
      }),
    );

    expect(changes.entities.map(({ name, status }) => [name, status])).toEqual([
      ["deep", "changed"],
      ["writer", "changed"],
    ]);
    expect(changes.entities[0].fields[0]).toMatchObject({
      kind: "note",
      text: expect.stringContaining("reached through another sub-agent"),
    });
    expect(changes.entities[1].fields[0]).toMatchObject({
      kind: "note",
      text: expect.stringContaining("Its own configuration changed"),
    });
    expect(changes.summary).toBe("2 sub-agents edited");
  });

  it("does not report a sub-agent that only appeared, beyond its addition", () => {
    const changes = diffVersions(
      edit({ subAgents: [], descendants: [] }),
      base,
    );
    expect(changes.entities).toEqual([
      expect.objectContaining({ name: "writer", status: "added" }),
    ]);
  });

  it("says so when nothing visible changed", () => {
    expect(diffVersions(base, base).summary).toBe("no visible change");
  });
});

describe("readSnapshot — tolerating snapshots of another shape", () => {
  it("fills what is missing with empty values", () => {
    expect(readSnapshot({ model: "m", mcpServers: [{ name: "x" }] })).toEqual({
      model: "m",
      systemPrompt: "",
      maxSteps: 0,
      skills: [],
      httpTools: [],
      mcpServers: [{ name: "x", toolNames: [], approvalToolNames: [] }],
      subAgents: [],
      descendants: [],
    });
  });

  it("diffs a malformed snapshot without throwing", () => {
    expect(() => diffVersions(null, base)).not.toThrow();
  });
});
