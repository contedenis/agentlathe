import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import {
  AGENT_RUN_CALL_KINDS,
  AGENT_RUN_SOURCES,
  DEFAULT_AGENT_RUN_TTL_DAYS,
  DEFAULT_TRACK_DASHBOARD_RUNS,
  DEFAULT_TRACK_MCP_RUNS,
  DEFAULT_TRACK_V1_RUNS,
  DEFAULT_TRANSCRIPT_TTL_DAYS,
  FIX_DRAFT_CATEGORIES,
  FIX_DRAFT_STATUSES,
} from "./constants";

export * from "./constants";

function sqlInList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(","));
}

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  model: text("model").notNull(),
  systemPrompt: text("system_prompt"),
  maxSteps: integer("max_steps").notNull().default(20),
  isActive: boolean("is_active").notNull().default(true),
  recordTraffic: boolean("record_traffic").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const skills = pgTable("skills", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  content: text("content").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const tools = pgTable("tools", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  endpoint: text("endpoint").notNull(),
  inputSchema: jsonb("input_schema").notNull(),
  needsApproval: boolean("needs_approval").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const mcpServers = pgTable("mcp_servers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  serverUrl: text("server_url").notNull(),
  authConfig: jsonb("auth_config"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    threadId: text("thread_id"),
    status: text("status").notNull().default("ok"),
    model: text("model"),
    durationMs: integer("duration_ms").notNull(),
    steps: integer("steps").notNull().default(0),
    toolCalls: integer("tool_calls").notNull().default(0),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    approvalsRequested: integer("approvals_requested").notNull().default(0),
    approvalsGranted: integer("approvals_granted").notNull().default(0),
    mcpFailures: jsonb("mcp_failures").$type<string[]>(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("agent_runs_agent_id_idx").on(table.agentId),
    index("agent_runs_created_at_idx").on(table.createdAt),
    index("agent_runs_source_idx").on(table.source),
    index("agent_runs_thread_id_idx").on(table.threadId),
    check(
      "agent_runs_source_check",
      sql`${table.source} in (${sqlInList(AGENT_RUN_SOURCES)})`,
    ),
    check("agent_runs_status_check", sql`${table.status} in ('ok','error')`),
  ],
);

export const settings = pgTable(
  "settings",
  {
    id: text("id").primaryKey().default("singleton"),
    trackDashboardRuns: boolean("track_dashboard_runs")
      .notNull()
      .default(DEFAULT_TRACK_DASHBOARD_RUNS),
    trackV1Runs: boolean("track_v1_runs")
      .notNull()
      .default(DEFAULT_TRACK_V1_RUNS),
    trackMcpRuns: boolean("track_mcp_runs")
      .notNull()
      .default(DEFAULT_TRACK_MCP_RUNS),
    agentRunTtlDays: integer("agent_run_ttl_days")
      .notNull()
      .default(DEFAULT_AGENT_RUN_TTL_DAYS),
    transcriptTtlDays: integer("transcript_ttl_days")
      .notNull()
      .default(DEFAULT_TRANSCRIPT_TTL_DAYS),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("settings_ttl_check", sql`${table.agentRunTtlDays} >= 0`),
    check(
      "settings_transcript_ttl_check",
      sql`${table.transcriptTtlDays} >= 0`,
    ),
  ],
);

export const agentRunCalls = pgTable(
  "agent_run_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    durationMs: integer("duration_ms"),
    status: text("status").notNull().default("ok"),
  },
  (table) => [
    index("agent_run_calls_run_id_idx").on(table.runId),
    index("agent_run_calls_name_idx").on(table.name),
    check(
      "agent_run_calls_kind_check",
      sql`${table.kind} in (${sqlInList(AGENT_RUN_CALL_KINDS)})`,
    ),
    check(
      "agent_run_calls_status_check",
      sql`${table.status} in ('ok','error','denied')`,
    ),
  ],
);

export const runTranscripts = pgTable(
  "run_transcripts",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    input: jsonb("input").notNull(),
    output: jsonb("output").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("run_transcripts_created_at_idx").on(table.createdAt)],
);

export const fixDrafts = pgTable(
  "fix_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    anchor: jsonb("anchor").notNull(),
    category: text("category").notNull(),
    rationale: text("rationale").notNull(),
    proposedValue: text("proposed_value"),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("fix_drafts_run_id_idx").on(table.runId),
    index("fix_drafts_status_idx").on(table.status),
    check(
      "fix_drafts_category_check",
      sql`${table.category} in (${sqlInList(FIX_DRAFT_CATEGORIES)})`,
    ),
    check(
      "fix_drafts_status_check",
      sql`${table.status} in (${sqlInList(FIX_DRAFT_STATUSES)})`,
    ),
  ],
);

export const agentSkills = pgTable(
  "agent_skills",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.skillId] }),
    index("agent_skills_skill_id_idx").on(table.skillId),
  ],
);

export const agentTools = pgTable(
  "agent_tools",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    toolId: uuid("tool_id")
      .notNull()
      .references(() => tools.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.toolId] }),
    index("agent_tools_tool_id_idx").on(table.toolId),
  ],
);

export const agentSubAgents = pgTable(
  "agent_sub_agents",
  {
    parentId: uuid("parent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    childId: uuid("child_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.parentId, table.childId] }),
    index("agent_sub_agents_child_id_idx").on(table.childId),
    check(
      "agent_sub_agents_parent_child_check",
      sql`${table.parentId} <> ${table.childId}`,
    ),
  ],
);

export const agentMcpTools = pgTable(
  "agent_mcp_tools",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    needsApproval: boolean("needs_approval").notNull().default(false),
  },
  (table) => [
    primaryKey({
      columns: [table.agentId, table.serverId, table.toolName],
    }),
    index("agent_mcp_tools_server_id_idx").on(table.serverId),
  ],
);

export const agentsRelations = relations(agents, ({ many }) => ({
  agentSkills: many(agentSkills),
  agentTools: many(agentTools),
  agentMcpTools: many(agentMcpTools),
  subAgents: many(agentSubAgents, { relationName: "parent" }),
  parentAgents: many(agentSubAgents, { relationName: "child" }),
  agentRuns: many(agentRuns),
}));

export const skillsRelations = relations(skills, ({ many }) => ({
  agentSkills: many(agentSkills),
}));

export const toolsRelations = relations(tools, ({ many }) => ({
  agentTools: many(agentTools),
}));

export const mcpServersRelations = relations(mcpServers, ({ many }) => ({
  agentMcpTools: many(agentMcpTools),
}));

export const agentRunsRelations = relations(agentRuns, ({ one, many }) => ({
  agent: one(agents, { fields: [agentRuns.agentId], references: [agents.id] }),
  transcript: one(runTranscripts, {
    fields: [agentRuns.id],
    references: [runTranscripts.runId],
  }),
  calls: many(agentRunCalls),
  fixDrafts: many(fixDrafts),
}));

export const runTranscriptsRelations = relations(runTranscripts, ({ one }) => ({
  run: one(agentRuns, {
    fields: [runTranscripts.runId],
    references: [agentRuns.id],
  }),
}));

export const agentRunCallsRelations = relations(agentRunCalls, ({ one }) => ({
  run: one(agentRuns, {
    fields: [agentRunCalls.runId],
    references: [agentRuns.id],
  }),
}));

export const fixDraftsRelations = relations(fixDrafts, ({ one }) => ({
  run: one(agentRuns, {
    fields: [fixDrafts.runId],
    references: [agentRuns.id],
  }),
}));

export const agentSkillsRelations = relations(agentSkills, ({ one }) => ({
  agent: one(agents, {
    fields: [agentSkills.agentId],
    references: [agents.id],
  }),
  skill: one(skills, {
    fields: [agentSkills.skillId],
    references: [skills.id],
  }),
}));

export const agentToolsRelations = relations(agentTools, ({ one }) => ({
  agent: one(agents, { fields: [agentTools.agentId], references: [agents.id] }),
  tool: one(tools, { fields: [agentTools.toolId], references: [tools.id] }),
}));

export const agentSubAgentsRelations = relations(agentSubAgents, ({ one }) => ({
  parent: one(agents, {
    fields: [agentSubAgents.parentId],
    references: [agents.id],
    relationName: "parent",
  }),
  child: one(agents, {
    fields: [agentSubAgents.childId],
    references: [agents.id],
    relationName: "child",
  }),
}));

export const agentMcpToolsRelations = relations(agentMcpTools, ({ one }) => ({
  agent: one(agents, {
    fields: [agentMcpTools.agentId],
    references: [agents.id],
  }),
  server: one(mcpServers, {
    fields: [agentMcpTools.serverId],
    references: [mcpServers.id],
  }),
}));
