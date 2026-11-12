CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"scope" text NOT NULL,
	"table_id" text,
	"agent_id" text,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"type" text NOT NULL,
	"body" text NOT NULL,
	"author" jsonb NOT NULL,
	"accepted_at" timestamp,
	"removed_at" timestamp,
	"revision" integer NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "memories_scope_check" CHECK (("memories"."scope" = 'workspace' and "memories"."table_id" is null and "memories"."agent_id" is null) or ("memories"."scope" = 'table' and "memories"."table_id" is not null and "memories"."agent_id" is null) or ("memories"."scope" = 'agent' and "memories"."agent_id" is not null and "memories"."table_id" is null))
);
--> statement-breakpoint
CREATE TABLE "memory_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"memory_id" text NOT NULL,
	"revision" integer NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"type" text NOT NULL,
	"body" text NOT NULL,
	"removed" boolean DEFAULT false NOT NULL,
	"author" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "memory_revisions_memory_revision" UNIQUE("memory_id","revision")
);
--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memories_scope_path_idx" ON "memories" USING btree ("owner_id","scope",coalesce("table_id", "agent_id", ''),"path");--> statement-breakpoint
CREATE INDEX "memories_table_idx" ON "memories" USING btree ("table_id");--> statement-breakpoint
CREATE INDEX "memories_agent_idx" ON "memories" USING btree ("agent_id");