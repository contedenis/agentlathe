DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'vector extension not installed: %', SQLERRM;
END $$;
--> statement-breakpoint
CREATE TABLE "agent_knowledge" (
	"agent_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	"mode" text DEFAULT 'search' NOT NULL,
	CONSTRAINT "agent_knowledge_agent_id_collection_id_pk" PRIMARY KEY("agent_id","collection_id"),
	CONSTRAINT "agent_knowledge_mode_check" CHECK ("agent_knowledge"."mode" in ('search','always'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"page" integer,
	"content" text NOT NULL,
	"embedding" real[] NOT NULL,
	"embedding_model" text NOT NULL,
	CONSTRAINT "knowledge_chunks_document_id_position_unique" UNIQUE("document_id","position")
);
--> statement-breakpoint
CREATE TABLE "knowledge_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_collections_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"size" integer NOT NULL,
	"text" text,
	"pages" integer,
	"chars" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"claim_id" uuid,
	"embedding_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_documents_media_type_check" CHECK ("knowledge_documents"."media_type" in ('application/pdf','text/markdown','text/plain')),
	CONSTRAINT "knowledge_documents_status_check" CHECK ("knowledge_documents"."status" in ('pending','processing','ready','failed'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_files" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"bytes" "bytea" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run_calls" DROP CONSTRAINT "agent_run_calls_kind_check";--> statement-breakpoint
ALTER TABLE "agent_knowledge" ADD CONSTRAINT "agent_knowledge_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge" ADD CONSTRAINT "agent_knowledge_collection_id_knowledge_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."knowledge_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_collection_id_knowledge_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."knowledge_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_files" ADD CONSTRAINT "knowledge_files_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_knowledge_collection_id_idx" ON "agent_knowledge" USING btree ("collection_id");--> statement-breakpoint
CREATE INDEX "knowledge_documents_collection_id_idx" ON "knowledge_documents" USING btree ("collection_id");--> statement-breakpoint
CREATE INDEX "knowledge_documents_waiting_idx" ON "knowledge_documents" USING btree ("created_at") WHERE "knowledge_documents"."status" in ('pending','processing');--> statement-breakpoint
ALTER TABLE "agent_run_calls" ADD CONSTRAINT "agent_run_calls_kind_check" CHECK ("agent_run_calls"."kind" in ('tool','mcp','sub_agent','skill','memory','knowledge'));