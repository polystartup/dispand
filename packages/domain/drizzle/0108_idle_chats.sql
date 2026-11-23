ALTER TABLE "step_runs" ADD COLUMN "idle_since" timestamp;--> statement-breakpoint
CREATE INDEX "step_runs_idle_idx" ON "step_runs" USING btree ("idle_since") WHERE "step_runs"."status" = 'running' and "step_runs"."idle_since" is not null;--> statement-breakpoint
UPDATE step_runs SET idle_since = coalesce(last_activity_at, started_at)
WHERE status = 'running' AND turn_status = 'idle' AND start->>'interactive' = 'true';
