ALTER TABLE "questions" ADD COLUMN "addressee_agent_id" text;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_addressee_agent_id_agents_id_fk" FOREIGN KEY ("addressee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "questions_addressee_agent_idx" ON "questions" USING btree ("addressee_agent_id");--> statement-breakpoint
-- Each consult is addressed to the agent it asks, when that agent is still there.
UPDATE "questions" SET "addressee_agent_id" = "payload"->>'agentId' WHERE "kind" = 'consult' AND EXISTS (SELECT 1 FROM "agents" a WHERE a."id" = "questions"."payload"->>'agentId');--> statement-breakpoint
-- The `inbox` bundle is gone: an agent reads only its own inbox.
UPDATE "agents" SET "bundles" = "bundles" - 'inbox'::text WHERE "bundles" ? 'inbox';--> statement-breakpoint
UPDATE "agents" SET "upstream" = jsonb_set("upstream", '{bundles}', ("upstream"->'bundles') - 'inbox'::text) WHERE jsonb_typeof("upstream"->'bundles') = 'array' AND ("upstream"->'bundles') ? 'inbox';--> statement-breakpoint
DELETE FROM "plugin_conflicts" WHERE "kind" = 'agent' AND "field" = 'bundles';--> statement-breakpoint
-- Questions and Approvals no longer start Jobs.
DELETE FROM "triggers" WHERE "config"->>'kind' = 'primitive' AND "config"->>'tableId' = 'interaction';
