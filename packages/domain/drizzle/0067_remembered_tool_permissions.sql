ALTER TABLE "questions" ADD COLUMN "remember" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "remembered" jsonb DEFAULT '{"allow":[],"deny":[]}'::jsonb NOT NULL;