CREATE TABLE "cloud_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"step_run_id" text NOT NULL,
	"harness_id" text NOT NULL,
	"model" text,
	"start" jsonb NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"queued" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pending" jsonb,
	"approved_call" text,
	"in_flight" jsonb,
	"allowed_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reminded" boolean DEFAULT false NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL,
	"last_event" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud_sessions" ADD CONSTRAINT "cloud_sessions_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_sessions" ADD CONSTRAINT "cloud_sessions_step_run_id_step_runs_id_fk" FOREIGN KEY ("step_run_id") REFERENCES "public"."step_runs"("id") ON DELETE cascade ON UPDATE no action;