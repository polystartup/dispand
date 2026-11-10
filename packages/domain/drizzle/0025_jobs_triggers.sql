CREATE TABLE "trigger_fires" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"trigger_id" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"run_id" text,
	"message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "trigger_fires_trigger_id_scheduled_for_unique" UNIQUE("trigger_id","scheduled_for")
);
--> statement-breakpoint
CREATE TABLE "triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"name" text NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"concurrency" text DEFAULT 'parallel' NOT NULL,
	"config" jsonb NOT NULL,
	"next_fire_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "workflow_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "source" text DEFAULT 'workflow' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "trigger_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "def" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cause" jsonb;--> statement-breakpoint
ALTER TABLE "trigger_fires" ADD CONSTRAINT "trigger_fires_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_fires" ADD CONSTRAINT "trigger_fires_trigger_id_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_fires" ADD CONSTRAINT "trigger_fires_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "triggers_agent_idx" ON "triggers" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "triggers_due_idx" ON "triggers" USING btree ("next_fire_at") WHERE "triggers"."enabled";--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_trigger_id_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."triggers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_agent_idx" ON "runs" USING btree ("agent_id","created_at");