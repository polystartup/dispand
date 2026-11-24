CREATE TABLE "personal_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"step_run_id" text NOT NULL,
	"runner_id" text NOT NULL,
	"enrollment_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "step_runs" ADD COLUMN "placement" jsonb;--> statement-breakpoint
ALTER TABLE "personal_grants" ADD CONSTRAINT "personal_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_grants" ADD CONSTRAINT "personal_grants_step_run_id_step_runs_id_fk" FOREIGN KEY ("step_run_id") REFERENCES "public"."step_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_grants" ADD CONSTRAINT "personal_grants_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_grants_step_idx" ON "personal_grants" USING btree ("step_run_id");