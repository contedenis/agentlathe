CREATE TABLE "schedule_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"nominal_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"run_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "schedule_occurrences_schedule_id_nominal_at_unique" UNIQUE("schedule_id","nominal_at"),
	CONSTRAINT "schedule_occurrences_status_check" CHECK ("schedule_occurrences"."status" in ('running','succeeded','failed','skipped_overlap','skipped_missed','blocked_preflight','interrupted'))
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"frequency" text NOT NULL,
	"time_of_day" text NOT NULL,
	"weekday" integer,
	"start_date" date,
	"timezone" text NOT NULL,
	"input" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"paused_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedules_frequency_check" CHECK ("schedules"."frequency" in ('hourly','daily','weekdays','weekly','monthly')),
	CONSTRAINT "schedules_time_of_day_check" CHECK ("schedules"."time_of_day" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "schedules_weekday_check" CHECK (("schedules"."frequency" = 'weekly') = ("schedules"."weekday" is not null) and ("schedules"."weekday" is null or "schedules"."weekday" between 0 and 6)),
	CONSTRAINT "schedules_start_date_check" CHECK ("schedules"."frequency" <> 'monthly' or "schedules"."start_date" is not null),
	CONSTRAINT "schedules_consecutive_failures_check" CHECK ("schedules"."consecutive_failures" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_source_check";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "schedule_id" uuid;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "track_schedule_runs" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "scheduler_heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedule_occurrences_run_id_idx" ON "schedule_occurrences" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "schedules_agent_id_idx" ON "schedules" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "schedules_next_run_at_idx" ON "schedules" USING btree ("next_run_at") WHERE "schedules"."is_active";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_schedule_id_idx" ON "agent_runs" USING btree ("schedule_id");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_source_check" CHECK ("agent_runs"."source" in ('dashboard','v1','mcp','schedule'));