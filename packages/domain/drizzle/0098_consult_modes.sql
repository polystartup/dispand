ALTER TABLE "agents" ADD COLUMN "consult_mode" text DEFAULT 'disabled' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_consult_mode_check" CHECK ("agents"."consult_mode" in ('disabled', 'auto', 'whitelist'));--> statement-breakpoint
-- An agent that lists anyone keeps consulting them: flagged entries are entries like the others.
UPDATE "agents" SET "consult_mode" = 'whitelist' WHERE EXISTS (SELECT 1 FROM "agent_consults" c WHERE c."agent_id" = "agents"."id");--> statement-breakpoint
-- A plugin's values gain the mode, as a definition without one sets it, and lose the flags.
UPDATE "agents" SET "upstream" = jsonb_set(
  "upstream",
  '{consults}',
  COALESCE((SELECT jsonb_agg(e - 'ask') FROM jsonb_array_elements("upstream"->'consults') e), '[]'::jsonb)
) || jsonb_build_object('consultMode', CASE WHEN jsonb_array_length("upstream"->'consults') > 0 THEN 'whitelist' ELSE 'disabled' END)
WHERE jsonb_typeof("upstream"->'consults') = 'array';--> statement-breakpoint
DELETE FROM "plugin_conflicts" WHERE "kind" = 'agent' AND "field" = 'consults';--> statement-breakpoint
-- No consult asks the owner first any more: one still waiting on its Approval is never opened (its Job waits until stopped),
-- and the Approvals go before their link does.
UPDATE "questions" SET "status" = 'expired' WHERE "status" = 'pending' AND "id" IN (SELECT "consult_id" FROM "questions" WHERE "consult_id" IS NOT NULL AND "status" = 'pending');--> statement-breakpoint
DELETE FROM "questions" WHERE "consult_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" DROP CONSTRAINT "questions_consult_id_questions_id_fk";--> statement-breakpoint
DROP INDEX "questions_consult_idx";--> statement-breakpoint
ALTER TABLE "questions" DROP COLUMN "consult_id";--> statement-breakpoint
ALTER TABLE "agent_consults" DROP COLUMN "ask";--> statement-breakpoint
UPDATE "user" SET "description" = left("description", 1000) WHERE char_length("description") > 1000;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_description_length" CHECK (char_length("user"."description") <= 1000);
