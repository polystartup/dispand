-- An agent's unattended Job may record no person: the run and every column that only copies its
-- person (its steps, sessions, messages, artifacts, roots and events) may be null. Nothing
-- writes null yet.
ALTER TABLE "artifacts" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_sessions" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "roots" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "step_runs" ALTER COLUMN "owner_id" DROP NOT NULL;