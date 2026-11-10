CREATE TABLE "proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"run_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"items" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"question_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"settled_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposals_run_idx" ON "proposals" USING btree ("run_id");