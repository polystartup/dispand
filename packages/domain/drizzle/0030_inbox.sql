ALTER TABLE "questions" ADD COLUMN "kind" text DEFAULT 'question' NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "answered_by" jsonb;--> statement-breakpoint
UPDATE "questions" SET "kind" = 'approval' WHERE "payload"->>'kind' = 'permission';