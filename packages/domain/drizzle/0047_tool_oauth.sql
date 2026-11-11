ALTER TABLE "tools" ADD COLUMN "auth" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "oauth_sealed" text;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "oauth_status" text;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "oauth_state_hash" text;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "oauth_client_id" text;--> statement-breakpoint
CREATE INDEX "tools_oauth_state_idx" ON "tools" USING btree ("oauth_state_hash");--> statement-breakpoint
-- An HTTP tool with headers signs in with them; every other one (runner tools included) with nothing.
UPDATE "tools" SET "auth" = 'headers' WHERE "kind" = 'http' AND "headers_sealed" <> '{}'::jsonb;
