ALTER TABLE "runs" ADD COLUMN "stopped" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Older engines recorded an intentional stop on the failed run.
UPDATE "runs" SET "stopped" = true WHERE "status" = 'failed' AND "error" IN ('Stopped', '{"key":"engine.fail.stopped"}');
