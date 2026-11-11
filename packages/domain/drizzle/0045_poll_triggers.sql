CREATE TABLE "poll_items" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"trigger_id" text NOT NULL,
	"item_id" text NOT NULL,
	"content" text NOT NULL,
	"first_seen" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"run_id" text,
	"message" text,
	"started_at" timestamp with time zone,
	CONSTRAINT "poll_items_trigger_id_item_id_unique" UNIQUE("trigger_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "polls" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"trigger_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"found" integer DEFAULT 0 NOT NULL,
	"fresh" integer DEFAULT 0 NOT NULL,
	"message" text
);
--> statement-breakpoint
ALTER TABLE "poll_items" ADD CONSTRAINT "poll_items_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_items" ADD CONSTRAINT "poll_items_trigger_id_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_items" ADD CONSTRAINT "poll_items_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_trigger_id_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "poll_items_deferred_idx" ON "poll_items" USING btree ("first_seen") WHERE "poll_items"."status" = 'deferred';--> statement-breakpoint
CREATE INDEX "poll_items_started_idx" ON "poll_items" USING btree ("trigger_id","started_at");--> statement-breakpoint
CREATE INDEX "poll_items_seen_idx" ON "poll_items" USING btree ("trigger_id","first_seen");--> statement-breakpoint
CREATE INDEX "polls_trigger_idx" ON "polls" USING btree ("trigger_id","at");