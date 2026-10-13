CREATE TABLE "agent_criteria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"question" text NOT NULL,
	"pass_description" text,
	"fail_description" text,
	"applies_when" text,
	"fail_below" real DEFAULT 0.2 NOT NULL,
	"pass_above" real DEFAULT 0.8 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"source_fix_draft_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_criteria_thresholds_check" CHECK (0 <= "agent_criteria"."fail_below" and "agent_criteria"."fail_below" <= "agent_criteria"."pass_above" and "agent_criteria"."pass_above" <= 1)
);
--> statement-breakpoint
CREATE TABLE "run_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"criterion_id" uuid NOT NULL,
	"question_snapshot" text NOT NULL,
	"p_pass" real,
	"p_applies" real,
	"status" text NOT NULL,
	"skip_reason" text,
	"error" text,
	"judge_model" text,
	"reviewed_verdict" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_evaluations_run_id_criterion_id_unique" UNIQUE("run_id","criterion_id"),
	CONSTRAINT "run_evaluations_status_check" CHECK ("run_evaluations"."status" in ('pass','fail','needs_review','not_applicable','skipped','error')),
	CONSTRAINT "run_evaluations_skip_reason_check" CHECK ("run_evaluations"."skip_reason" in ('too_long','awaiting_approval')),
	CONSTRAINT "run_evaluations_reviewed_verdict_check" CHECK ("run_evaluations"."reviewed_verdict" in ('pass','fail'))
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "auto_evaluate" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "judge_model" text DEFAULT 'typesafe/jev-1.13' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_criteria" ADD CONSTRAINT "agent_criteria_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_criteria" ADD CONSTRAINT "agent_criteria_source_fix_draft_id_fix_drafts_id_fk" FOREIGN KEY ("source_fix_draft_id") REFERENCES "public"."fix_drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_evaluations" ADD CONSTRAINT "run_evaluations_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_evaluations" ADD CONSTRAINT "run_evaluations_criterion_id_agent_criteria_id_fk" FOREIGN KEY ("criterion_id") REFERENCES "public"."agent_criteria"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_criteria_agent_id_idx" ON "agent_criteria" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "run_evaluations_criterion_id_idx" ON "run_evaluations" USING btree ("criterion_id");