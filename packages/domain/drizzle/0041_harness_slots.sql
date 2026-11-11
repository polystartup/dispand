ALTER TABLE "harnesses" ADD COLUMN "max_working" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "step_runs" ADD COLUMN "harness_id" text;--> statement-breakpoint
ALTER TABLE "step_runs" ADD COLUMN "working" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "step_runs" ADD COLUMN "queued_at" timestamp;--> statement-breakpoint
ALTER TABLE "step_runs" ADD COLUMN "queue_class" text;--> statement-breakpoint
ALTER TABLE "step_runs" ADD COLUMN "pending_action" jsonb;--> statement-breakpoint
ALTER TABLE "step_runs" ADD CONSTRAINT "step_runs_harness_id_harnesses_id_fk" FOREIGN KEY ("harness_id") REFERENCES "public"."harnesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "step_runs_queued_idx" ON "step_runs" USING btree ("harness_id","queued_at") WHERE "step_runs"."queued_at" is not null;--> statement-breakpoint
CREATE INDEX "step_runs_working_idx" ON "step_runs" USING btree ("harness_id") WHERE "step_runs"."working";--> statement-breakpoint
ALTER TABLE "harnesses" ADD CONSTRAINT "harnesses_max_working_range" CHECK ("harnesses"."max_working" between 1 and 100);--> statement-breakpoint
-- Open agent steps with a session: the harness it runs on.
UPDATE "step_runs" SET "harness_id" = h."id"
FROM "harnesses" h
WHERE h."id" = "step_runs"."harness"->>'id' AND "step_runs"."status" IN ('pending', 'running', 'waiting');--> statement-breakpoint
-- Open agent steps without one: the Job's snapshot, or the workflow step's agent as it is now.
UPDATE "step_runs" SET "harness_id" = h."id"
FROM "runs" r
LEFT JOIN "workflow_versions" v ON v."workflow_id" = r."workflow_id" AND v."version" = r."version"
CROSS JOIN LATERAL (
  SELECT n->>'id' AS "node_id", n->>'agentId' AS "agent_id" FROM jsonb_array_elements(coalesce(r."def", v."def")->'steps') n
  UNION ALL
  SELECT coalesce(r."def", v."def")->'trigger'->'field'->>'id', coalesce(r."def", v."def")->'trigger'->'field'->>'agentId'
) node
LEFT JOIN "agents" a ON a."id" = node."agent_id"
JOIN "harnesses" h ON h."id" = coalesce(r."snapshot"->>'harnessId', a."harness_id")
WHERE r."id" = "step_runs"."run_id" AND node."node_id" = "step_runs"."node_id" AND node."agent_id" IS NOT NULL
  AND "step_runs"."harness_id" IS NULL AND "step_runs"."status" IN ('pending', 'running', 'waiting');--> statement-breakpoint
-- Sessions working on a turn as this deploys count against the limit.
UPDATE "step_runs" SET "working" = true WHERE "status" = 'running' AND "session_id" IS NOT NULL AND "harness_id" IS NOT NULL;
