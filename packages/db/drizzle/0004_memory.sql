CREATE TABLE "memory_compactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"partition_key" text NOT NULL,
	"from_revision" integer NOT NULL,
	"to_revision" integer,
	"model" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"operations" jsonb,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "memory_compactions_status_check" CHECK ("memory_compactions"."status" in ('running','applied','failed'))
);
--> statement-breakpoint
CREATE TABLE "memory_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"partition_key" text NOT NULL,
	"short_id" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_entries_store_id_partition_key_short_id_unique" UNIQUE("store_id","partition_key","short_id")
);
--> statement-breakpoint
CREATE TABLE "memory_entry_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"op" text NOT NULL,
	"content" text,
	"run_id" uuid,
	"author" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_entry_versions_op_check" CHECK ("memory_entry_versions"."op" in ('add','update','delete','compaction','restore')),
	CONSTRAINT "memory_entry_versions_author_check" CHECK ("memory_entry_versions"."author" in ('agent','human','compaction'))
);
--> statement-breakpoint
CREATE TABLE "memory_partitions" (
	"store_id" uuid NOT NULL,
	"partition_key" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"chars" integer DEFAULT 0 NOT NULL,
	"next_entry_number" integer DEFAULT 1 NOT NULL,
	"compacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_partitions_store_id_partition_key_pk" PRIMARY KEY("store_id","partition_key")
);
--> statement-breakpoint
CREATE TABLE "memory_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"partition_key" text NOT NULL,
	"op" text NOT NULL,
	"entry_id" uuid,
	"content" text,
	"base_revision" integer NOT NULL,
	"run_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "memory_proposals_op_check" CHECK ("memory_proposals"."op" in ('add','update','delete')),
	CONSTRAINT "memory_proposals_status_check" CHECK ("memory_proposals"."status" in ('pending','approved','rejected'))
);
--> statement-breakpoint
CREATE TABLE "memory_stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"scope" text NOT NULL,
	"owner_agent_id" uuid NOT NULL,
	"memory_key" text,
	"purpose" text NOT NULL,
	"char_limit" integer DEFAULT 8000 NOT NULL,
	"require_approval" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_stores_owner_agent_id_scope_unique" UNIQUE("owner_agent_id","scope"),
	CONSTRAINT "memory_stores_scope_check" CHECK ("memory_stores"."scope" in ('agent','agent_subject','custom')),
	CONSTRAINT "memory_stores_memory_key_check" CHECK (("memory_stores"."scope" = 'custom') = ("memory_stores"."memory_key" is not null)),
	CONSTRAINT "memory_stores_char_limit_check" CHECK ("memory_stores"."char_limit" between 1 and 20000)
);
--> statement-breakpoint
ALTER TABLE "agent_run_calls" DROP CONSTRAINT "agent_run_calls_kind_check";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "subject_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "warnings" jsonb;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "memory_seen" jsonb;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "subject_id" text;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "memory_key" text;--> statement-breakpoint
ALTER TABLE "memory_compactions" ADD CONSTRAINT "memory_compactions_partition_fk" FOREIGN KEY ("store_id","partition_key") REFERENCES "public"."memory_partitions"("store_id","partition_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_partition_fk" FOREIGN KEY ("store_id","partition_key") REFERENCES "public"."memory_partitions"("store_id","partition_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entry_versions" ADD CONSTRAINT "memory_entry_versions_entry_id_memory_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."memory_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entry_versions" ADD CONSTRAINT "memory_entry_versions_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_partitions" ADD CONSTRAINT "memory_partitions_store_id_memory_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."memory_stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_proposals" ADD CONSTRAINT "memory_proposals_entry_id_memory_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."memory_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_proposals" ADD CONSTRAINT "memory_proposals_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_proposals" ADD CONSTRAINT "memory_proposals_partition_fk" FOREIGN KEY ("store_id","partition_key") REFERENCES "public"."memory_partitions"("store_id","partition_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_stores" ADD CONSTRAINT "memory_stores_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_entry_versions_entry_id_revision_idx" ON "memory_entry_versions" USING btree ("entry_id","revision");--> statement-breakpoint
CREATE INDEX "memory_entry_versions_run_id_idx" ON "memory_entry_versions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "memory_proposals_run_id_idx" ON "memory_proposals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "agent_runs_subject_id_idx" ON "agent_runs" USING btree ("subject_id");--> statement-breakpoint
ALTER TABLE "agent_run_calls" ADD CONSTRAINT "agent_run_calls_kind_check" CHECK ("agent_run_calls"."kind" in ('tool','mcp','sub_agent','skill','memory'));