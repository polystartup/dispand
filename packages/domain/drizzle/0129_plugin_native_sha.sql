ALTER TABLE "plugins" ADD COLUMN "native_sha" text;--> statement-breakpoint
-- A revision kept before this column was read at the plugin's commit then, still its own.
UPDATE "plugins" SET "native_sha" = "sha" WHERE "native_digest" IS NOT NULL;
