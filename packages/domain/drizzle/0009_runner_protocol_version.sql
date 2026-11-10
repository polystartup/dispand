ALTER TABLE "runners" ADD COLUMN "protocol_version" integer;--> statement-breakpoint
-- Every runner seen before this migration spoke protocol 1: Settings tells the owner to update it.
UPDATE "runners" SET "protocol_version" = 1 WHERE "last_seen_at" IS NOT NULL;
