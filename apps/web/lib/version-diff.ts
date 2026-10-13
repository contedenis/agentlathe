import type { AgentVersionSnapshot } from "@agentlathe/runner";
import { structuredPatch } from "diff";

export type VersionSnapshot = AgentVersionSnapshot;

type Skill = VersionSnapshot["skills"][number];
type HttpTool = VersionSnapshot["httpTools"][number];
type McpServer = VersionSnapshot["mcpServers"][number];
type SubAgent = VersionSnapshot["subAgents"][number];

export type DiffLine = {
  kind: "context" | "added" | "removed";
  text: string;
};

export type FieldChange =
  | { label: string; kind: "value"; from: string | null; to: string | null }
  | { label: string; kind: "text"; hunks: DiffLine[][] }
  | { label: string; kind: "note"; text: string };

export type EntityKind = "skill" | "tool" | "mcp" | "sub_agent";

export type EntityChange = {
  kind: EntityKind;
  name: string;
  status: "added" | "removed" | "changed";
  fields: FieldChange[];
};

export type VersionChanges = {
  agent: FieldChange[];
  entities: EntityChange[];
  summary: string;
};

const asArray = <T>(value: unknown): T[] =>
  Array.isArray(value) ? (value as T[]) : [];

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

export function readSnapshot(raw: unknown): VersionSnapshot {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    model: asString(value.model),
    systemPrompt: asString(value.systemPrompt),
    maxSteps: typeof value.maxSteps === "number" ? value.maxSteps : 0,
    skills: asArray<Skill>(value.skills),
    httpTools: asArray<HttpTool>(value.httpTools),
    mcpServers: asArray<McpServer>(value.mcpServers).map((server) => ({
      ...server,
      toolNames: asArray<string>(server.toolNames),
      approvalToolNames: asArray<string>(server.approvalToolNames),
    })),
    subAgents: asArray<SubAgent>(value.subAgents),
    descendants: asArray<{ slug: string; hash: string }>(value.descendants),
  };
}

const withNewline = (text: string) =>
  text === "" || text.endsWith("\n") ? text : `${text}\n`;

export function diffText(from: string, to: string): DiffLine[][] {
  const patch = structuredPatch(
    "",
    "",
    withNewline(from),
    withNewline(to),
    "",
    "",
    { context: 3 },
  );
  return patch.hunks.map((hunk) =>
    hunk.lines
      .filter((line) => !line.startsWith("\\"))
      .map((line) => ({
        kind:
          line[0] === "+" ? "added" : line[0] === "-" ? "removed" : "context",
        text: line.slice(1),
      })),
  );
}

type FieldSpec<T> = {
  label: string;
  kind: "text" | "value";
  read: (entity: T) => string;
};

function diffField<T>(
  spec: FieldSpec<T>,
  from: T | undefined,
  to: T | undefined,
): FieldChange | null {
  const before = from === undefined ? null : spec.read(from);
  const after = to === undefined ? null : spec.read(to);
  if (before === after) return null;
  if (spec.kind === "value")
    return { label: spec.label, kind: "value", from: before, to: after };
  const hunks = diffText(before ?? "", after ?? "");
  return hunks.length > 0 ? { label: spec.label, kind: "text", hunks } : null;
}

function diffEntities<T>(
  kind: EntityKind,
  from: T[],
  to: T[],
  key: (entity: T) => string,
  specs: FieldSpec<T>[],
): EntityChange[] {
  const before = new Map(from.map((entity) => [key(entity), entity]));
  const after = new Map(to.map((entity) => [key(entity), entity]));
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  return names.flatMap((name) => {
    const old = before.get(name);
    const next = after.get(name);
    const fields = specs
      .map((spec) => diffField(spec, old, next))
      .filter((field): field is FieldChange => field !== null);
    if (old && next && fields.length === 0) return [];
    return [
      {
        kind,
        name,
        status: !old ? "added" : !next ? "removed" : "changed",
        fields,
      },
    ];
  });
}

const yesNo = (value: boolean) => (value ? "yes" : "no");

const lines = (values: string[]) => values.join("\n");

const SKILL_FIELDS: FieldSpec<Skill>[] = [
  { label: "Description", kind: "text", read: (s) => asString(s.description) },
  { label: "Content", kind: "text", read: (s) => asString(s.content) },
];

const TOOL_FIELDS: FieldSpec<HttpTool>[] = [
  { label: "Description", kind: "text", read: (t) => asString(t.description) },
  { label: "Endpoint", kind: "value", read: (t) => asString(t.endpoint) },
  {
    label: "Input schema",
    kind: "text",
    read: (t) => JSON.stringify(t.inputSchema ?? null, null, 2),
  },
  {
    label: "Requires approval",
    kind: "value",
    read: (t) => yesNo(Boolean(t.needsApproval)),
  },
];

const MCP_FIELDS: FieldSpec<McpServer>[] = [
  { label: "Server URL", kind: "value", read: (s) => asString(s.serverUrl) },
  { label: "Selected tools", kind: "text", read: (s) => lines(s.toolNames) },
  {
    label: "Tools requiring approval",
    kind: "text",
    read: (s) => lines(s.approvalToolNames),
  },
];

const SUB_AGENT_FIELDS: FieldSpec<SubAgent>[] = [
  {
    label: "Description the parent sees",
    kind: "text",
    read: (s) => asString(s.description),
  },
];

function descendantChanges(
  from: VersionSnapshot,
  to: VersionSnapshot,
  entities: EntityChange[],
): EntityChange[] {
  const before = new Map(from.descendants.map((d) => [d.slug, d.hash]));
  const direct = new Set(to.subAgents.map((child) => child.slug));
  const extra: EntityChange[] = [];
  for (const { slug, hash } of to.descendants) {
    const previous = before.get(slug);
    if (previous === undefined || previous === hash) continue;
    const note: FieldChange = {
      label: "Configuration",
      kind: "note",
      text: direct.has(slug)
        ? "Its own configuration changed. Its metrics page shows its versions."
        : "The configuration of this agent, reached through another sub-agent, changed. Its metrics page shows its versions.",
    };
    const existing = entities.find(
      (entity) => entity.kind === "sub_agent" && entity.name === slug,
    );
    if (existing) existing.fields.push(note);
    else
      extra.push({
        kind: "sub_agent",
        name: slug,
        status: "changed",
        fields: [note],
      });
  }
  return extra;
}

const KIND_NOUN: Record<EntityKind, [string, string]> = {
  skill: ["skill", "skills"],
  tool: ["tool", "tools"],
  mcp: ["MCP server", "MCP servers"],
  sub_agent: ["sub-agent", "sub-agents"],
};

function summarize(agent: FieldChange[], entities: EntityChange[]): string {
  const parts: string[] = [];
  const labels = new Set(agent.map((field) => field.label));
  if (labels.has("System prompt")) parts.push("prompt edited");
  if (labels.has("Model")) parts.push("model");
  if (labels.has("Max steps")) parts.push("max steps");
  for (const kind of Object.keys(KIND_NOUN) as EntityKind[]) {
    const [one, many] = KIND_NOUN[kind];
    const count = (status: EntityChange["status"]) =>
      entities.filter((e) => e.kind === kind && e.status === status).length;
    const noun = (n: number) => (n === 1 ? one : many);
    const added = count("added");
    const removed = count("removed");
    const changed = count("changed");
    if (added > 0) parts.push(`+${added} ${noun(added)}`);
    if (removed > 0) parts.push(`−${removed} ${noun(removed)}`);
    if (changed > 0) parts.push(`${changed} ${noun(changed)} edited`);
  }
  return parts.length > 0 ? parts.join(" · ") : "no visible change";
}

export function diffVersions(fromRaw: unknown, toRaw: unknown): VersionChanges {
  const from = readSnapshot(fromRaw);
  const to = readSnapshot(toRaw);

  const agent: FieldChange[] = [];
  if (from.model !== to.model)
    agent.push({
      label: "Model",
      kind: "value",
      from: from.model,
      to: to.model,
    });
  if (from.maxSteps !== to.maxSteps)
    agent.push({
      label: "Max steps",
      kind: "value",
      from: String(from.maxSteps),
      to: String(to.maxSteps),
    });
  if (from.systemPrompt !== to.systemPrompt)
    agent.push({
      label: "System prompt",
      kind: "text",
      hunks: diffText(from.systemPrompt, to.systemPrompt),
    });

  const entities = [
    ...diffEntities(
      "skill",
      from.skills,
      to.skills,
      (s) => s.name,
      SKILL_FIELDS,
    ),
    ...diffEntities(
      "tool",
      from.httpTools,
      to.httpTools,
      (t) => t.name,
      TOOL_FIELDS,
    ),
    ...diffEntities(
      "mcp",
      from.mcpServers,
      to.mcpServers,
      (s) => s.name,
      MCP_FIELDS,
    ),
  ];
  const subAgents = diffEntities(
    "sub_agent",
    from.subAgents,
    to.subAgents,
    (s) => s.slug,
    SUB_AGENT_FIELDS,
  );
  subAgents.push(...descendantChanges(from, to, subAgents));
  entities.push(
    ...subAgents.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    ),
  );

  return { agent, entities, summary: summarize(agent, entities) };
}
