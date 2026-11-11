CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"table_id" text NOT NULL,
	"row_id" text NOT NULL,
	"operation" text NOT NULL,
	"changed_field_ids" jsonb NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"actor" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_unprocessed_idx" ON "events" USING btree ("created_at") WHERE "events"."processed_at" is null;--> statement-breakpoint
CREATE INDEX "events_table_row_idx" ON "events" USING btree ("table_id","row_id");