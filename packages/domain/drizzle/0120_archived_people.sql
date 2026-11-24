ALTER TABLE "user" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "archived_by" text;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_archived_by_organizations_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;