ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "cloud_sessions" DROP CONSTRAINT "cloud_sessions_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "step_runs" DROP CONSTRAINT "step_runs_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "artifacts" DROP COLUMN "owner_id";--> statement-breakpoint
ALTER TABLE "cloud_sessions" DROP COLUMN "owner_id";--> statement-breakpoint
ALTER TABLE "step_runs" DROP COLUMN "owner_id";