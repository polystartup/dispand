CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"position" integer GENERATED ALWAYS AS IDENTITY (sequence name "messages_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"owner_id" text NOT NULL,
	"run_id" text NOT NULL,
	"step_run_id" text NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"delivered_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"run_id" text NOT NULL,
	"step_run_id" text NOT NULL,
	"session_id" text NOT NULL,
	"runner_question_id" text NOT NULL,
	"placement" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"answer" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"answered_at" timestamp,
	"delivered_at" timestamp,
	"orphaned" boolean DEFAULT false NOT NULL,
	CONSTRAINT "questions_session_id_runner_question_id_unique" UNIQUE("session_id","runner_question_id")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "step_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"run_id" text NOT NULL,
	"node_id" text NOT NULL,
	"status" text NOT NULL,
	"session_id" text,
	"harness" jsonb,
	"runner_id" text,
	"start" jsonb,
	"start_delivered_at" timestamp,
	"last_activity_at" timestamp,
	"cli_session_id" text,
	"event_seq" bigint DEFAULT 0 NOT NULL,
	"outputs" jsonb,
	"error" text,
	"started_at" timestamp,
	"finished_at" timestamp,
	CONSTRAINT "step_runs_session_id_unique" UNIQUE("session_id"),
	CONSTRAINT "step_runs_run_id_node_id_unique" UNIQUE("run_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "workflow_versions" (
	"workflow_id" text NOT NULL,
	"version" integer NOT NULL,
	"owner_id" text NOT NULL,
	"def" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_versions_workflow_id_version_pk" PRIMARY KEY("workflow_id","version")
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"current_version" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "runner_events" CASCADE;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_step_run_id_step_runs_id_fk" FOREIGN KEY ("step_run_id") REFERENCES "public"."step_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_step_run_id_step_runs_id_fk" FOREIGN KEY ("step_run_id") REFERENCES "public"."step_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_runs" ADD CONSTRAINT "step_runs_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_runs" ADD CONSTRAINT "step_runs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_step_idx" ON "messages" USING btree ("step_run_id","position");--> statement-breakpoint
CREATE INDEX "messages_run_idx" ON "messages" USING btree ("run_id","position");--> statement-breakpoint
CREATE INDEX "questions_run_idx" ON "questions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "runs_workflow_idx" ON "runs" USING btree ("workflow_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_status_idx" ON "runs" USING btree ("status");