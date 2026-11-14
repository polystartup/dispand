DROP INDEX "tools_owner_name_idx";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "upstream" jsonb;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "overridden" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "upstream" jsonb;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "overridden" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tools_owner_name_idx" ON "tools" USING btree ("owner_id",coalesce("plugin_id", ''),lower("name"));--> statement-breakpoint
UPDATE "agents" SET "upstream" = jsonb_build_object(
  'name', "name", 'description', "description", 'systemPrompt', "system_prompt", 'bundles', "bundles", 'dataTables', "data_tables", 'selfLearning', "self_learning",
  'skillPackageIds', coalesce((SELECT jsonb_agg("package_id") FROM "agent_skills" WHERE "agent_id" = "agents"."id"), '[]'::jsonb),
  'toolIds', coalesce((SELECT jsonb_agg("tool_id") FROM "agent_tools" WHERE "agent_id" = "agents"."id"), '[]'::jsonb),
  'consults', coalesce((SELECT jsonb_agg(jsonb_build_object('agentId', "consulted_id", 'ask', "ask")) FROM "agent_consults" WHERE "agent_id" = "agents"."id"), '[]'::jsonb)
) WHERE "plugin_id" IS NOT NULL;--> statement-breakpoint
UPDATE "tools" SET "upstream" = jsonb_build_object('name', "name", 'url', "url", 'transport', "transport") WHERE "plugin_id" IS NOT NULL AND "kind" = 'http';
