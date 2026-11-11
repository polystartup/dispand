CREATE TABLE "roots" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"kind" text NOT NULL,
	"run_id" text,
	"jobs" integer DEFAULT 0 NOT NULL,
	"counted_from" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'going' NOT NULL,
	"dont_ask" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_settings" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"checkpoint" integer DEFAULT 100 NOT NULL,
	CONSTRAINT "workspace_settings_checkpoint_range" CHECK ("workspace_settings"."checkpoint" between 1 and 100000)
);
--> statement-breakpoint
ALTER TABLE "questions" ALTER COLUMN "step_run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ALTER COLUMN "runner_question_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "root_id" text;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "root_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "root_id" text;--> statement-breakpoint
ALTER TABLE "roots" ADD CONSTRAINT "roots_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "roots_paused_idx" ON "roots" USING btree ("owner_id") WHERE "roots"."state" = 'paused';--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_root_id_roots_id_fk" FOREIGN KEY ("root_id") REFERENCES "public"."roots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_root_id_roots_id_fk" FOREIGN KEY ("root_id") REFERENCES "public"."roots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_root_id_roots_id_fk" FOREIGN KEY ("root_id") REFERENCES "public"."roots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "questions_checkpoint_idx" ON "questions" USING btree ("root_id") WHERE "questions"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "runs_root_idx" ON "runs" USING btree ("root_id");--> statement-breakpoint
-- Every Job made so far counts toward one root: its chain's first Job's (as the chain limit counted them), or its own.
INSERT INTO "roots" ("id", "owner_id", "kind", "run_id", "jobs", "created_at")
SELECT 'root_' || c."root", c."owner_id",
  CASE first."cause"->>'kind' WHEN 'schedule' THEN 'schedule' WHEN 'event' THEN 'event' WHEN 'poll' THEN 'poll' ELSE 'user' END,
  first."id", c."jobs", c."since"
FROM (
  SELECT coalesce("cause"->>'rootJobId', "id") AS "root", "owner_id", count(*)::integer AS "jobs", min("created_at") AS "since"
  FROM "runs" WHERE "source" = 'agent' GROUP BY 1, 2
) c
LEFT JOIN "runs" first ON first."id" = c."root";--> statement-breakpoint
UPDATE "runs" SET "root_id" = 'root_' || coalesce("cause"->>'rootJobId', "id") WHERE "source" = 'agent';--> statement-breakpoint
-- Events not handled yet that a Job wrote: its root.
UPDATE "events" SET "root_id" = r."root_id" FROM "runs" r WHERE r."id" = "events"."actor"->>'runId' AND "events"."processed_at" IS NULL;--> statement-breakpoint
-- The chain limit is gone: what it stopped reads as refused, with its message.
UPDATE "event_fires" SET "status" = 'refused' WHERE "status" = 'chain-limit';
