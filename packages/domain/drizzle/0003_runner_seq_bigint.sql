ALTER TABLE "runner_events" ALTER COLUMN "seq" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "runners" ALTER COLUMN "last_seq" SET DATA TYPE bigint;