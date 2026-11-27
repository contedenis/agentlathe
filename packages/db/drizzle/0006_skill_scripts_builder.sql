ALTER TABLE "settings" ADD COLUMN "builder_model" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "script" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "input_schema" jsonb;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "needs_approval" boolean DEFAULT false NOT NULL;