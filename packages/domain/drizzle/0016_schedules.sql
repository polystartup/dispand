CREATE TABLE "schedule_fires" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"run_id" text,
	"message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_fires_workflow_id_scheduled_for_unique" UNIQUE("workflow_id","scheduled_for")
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"workflow_id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"cron" text NOT NULL,
	"timezone" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_fire_at" timestamp with time zone NOT NULL,
	"last_checked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "trigger" jsonb DEFAULT '{"type":"manual"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_fires" ADD CONSTRAINT "schedule_fires_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_fires" ADD CONSTRAINT "schedule_fires_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_fires" ADD CONSTRAINT "schedule_fires_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedules_due_idx" ON "schedules" USING btree ("next_fire_at");