CREATE TABLE "agent_mcp_tools" (
	"agent_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"needs_approval" boolean DEFAULT false NOT NULL,
	CONSTRAINT "agent_mcp_tools_agent_id_server_id_tool_name_pk" PRIMARY KEY("agent_id","server_id","tool_name")
);
--> statement-breakpoint
CREATE TABLE "agent_run_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"duration_ms" integer,
	"status" text DEFAULT 'ok' NOT NULL,
	CONSTRAINT "agent_run_calls_kind_check" CHECK ("agent_run_calls"."kind" in ('tool','mcp','sub_agent','skill')),
	CONSTRAINT "agent_run_calls_status_check" CHECK ("agent_run_calls"."status" in ('ok','error','denied'))
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"source" text NOT NULL,
	"thread_id" text,
	"status" text DEFAULT 'ok' NOT NULL,
	"model" text,
	"duration_ms" integer NOT NULL,
	"steps" integer DEFAULT 0 NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"approvals_requested" integer DEFAULT 0 NOT NULL,
	"approvals_granted" integer DEFAULT 0 NOT NULL,
	"mcp_failures" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runs_source_check" CHECK ("agent_runs"."source" in ('dashboard','v1','mcp')),
	CONSTRAINT "agent_runs_status_check" CHECK ("agent_runs"."status" in ('ok','error'))
);
--> statement-breakpoint
CREATE TABLE "agent_skills" (
	"agent_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	CONSTRAINT "agent_skills_agent_id_skill_id_pk" PRIMARY KEY("agent_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "agent_sub_agents" (
	"parent_id" uuid NOT NULL,
	"child_id" uuid NOT NULL,
	CONSTRAINT "agent_sub_agents_parent_id_child_id_pk" PRIMARY KEY("parent_id","child_id"),
	CONSTRAINT "agent_sub_agents_parent_child_check" CHECK ("agent_sub_agents"."parent_id" <> "agent_sub_agents"."child_id")
);
--> statement-breakpoint
CREATE TABLE "agent_tools" (
	"agent_id" uuid NOT NULL,
	"tool_id" uuid NOT NULL,
	CONSTRAINT "agent_tools_agent_id_tool_id_pk" PRIMARY KEY("agent_id","tool_id")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"model" text NOT NULL,
	"system_prompt" text,
	"max_steps" integer DEFAULT 20 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"record_traffic" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_name_unique" UNIQUE("name"),
	CONSTRAINT "agents_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "fix_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"anchor" jsonb NOT NULL,
	"category" text NOT NULL,
	"rationale" text NOT NULL,
	"proposed_value" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fix_drafts_category_check" CHECK ("fix_drafts"."category" in ('prompt','tool_definition','tool_policy','missing_tool','model','other')),
	CONSTRAINT "fix_drafts_status_check" CHECK ("fix_drafts"."status" in ('open','dismissed','applied'))
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"server_url" text NOT NULL,
	"auth_config" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_transcripts" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"track_dashboard_runs" boolean DEFAULT true NOT NULL,
	"track_v1_runs" boolean DEFAULT false NOT NULL,
	"track_mcp_runs" boolean DEFAULT false NOT NULL,
	"agent_run_ttl_days" integer DEFAULT 90 NOT NULL,
	"transcript_ttl_days" integer DEFAULT 14 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_ttl_check" CHECK ("settings"."agent_run_ttl_days" >= 0),
	CONSTRAINT "settings_transcript_ttl_check" CHECK ("settings"."transcript_ttl_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"content" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"endpoint" text NOT NULL,
	"input_schema" jsonb NOT NULL,
	"needs_approval" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_mcp_tools" ADD CONSTRAINT "agent_mcp_tools_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mcp_tools" ADD CONSTRAINT "agent_mcp_tools_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_calls" ADD CONSTRAINT "agent_run_calls_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sub_agents" ADD CONSTRAINT "agent_sub_agents_parent_id_agents_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sub_agents" ADD CONSTRAINT "agent_sub_agents_child_id_agents_id_fk" FOREIGN KEY ("child_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_drafts" ADD CONSTRAINT "fix_drafts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_transcripts" ADD CONSTRAINT "run_transcripts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_mcp_tools_server_id_idx" ON "agent_mcp_tools" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "agent_run_calls_run_id_idx" ON "agent_run_calls" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "agent_run_calls_name_idx" ON "agent_run_calls" USING btree ("name");--> statement-breakpoint
CREATE INDEX "agent_runs_agent_id_idx" ON "agent_runs" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_runs_created_at_idx" ON "agent_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_source_idx" ON "agent_runs" USING btree ("source");--> statement-breakpoint
CREATE INDEX "agent_runs_thread_id_idx" ON "agent_runs" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "agent_skills_skill_id_idx" ON "agent_skills" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "agent_sub_agents_child_id_idx" ON "agent_sub_agents" USING btree ("child_id");--> statement-breakpoint
CREATE INDEX "agent_tools_tool_id_idx" ON "agent_tools" USING btree ("tool_id");--> statement-breakpoint
CREATE INDEX "fix_drafts_run_id_idx" ON "fix_drafts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "fix_drafts_status_idx" ON "fix_drafts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "run_transcripts_created_at_idx" ON "run_transcripts" USING btree ("created_at");