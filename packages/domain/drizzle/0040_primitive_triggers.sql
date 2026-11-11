CREATE TABLE "event_fires" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"trigger_id" text NOT NULL,
	"event_id" text NOT NULL,
	"status" text NOT NULL,
	"run_id" text,
	"message" text,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	CONSTRAINT "event_fires_trigger_id_event_id_unique" UNIQUE("trigger_id","event_id")
);
--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "rate_cap" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "event_fires" ADD CONSTRAINT "event_fires_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_fires" ADD CONSTRAINT "event_fires_trigger_id_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_fires" ADD CONSTRAINT "event_fires_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_fires" ADD CONSTRAINT "event_fires_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_fires_deferred_idx" ON "event_fires" USING btree ("created_at") WHERE "event_fires"."status" = 'deferred';--> statement-breakpoint
CREATE INDEX "event_fires_started_idx" ON "event_fires" USING btree ("trigger_id","started_at");