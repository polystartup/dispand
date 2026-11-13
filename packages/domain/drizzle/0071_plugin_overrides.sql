DROP INDEX "tools_owner_name_idx";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "upstream" jsonb;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "overridden" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "upstream" jsonb;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "overridden" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tools_owner_name_idx" ON "tools" USING btree ("owner_id",coalesce("plugin_id", ''),lower("name"));--> statement-breakpoint
UPDATE "agents" SET "upstream" = jsonb_build_object('name', "name", 'description', "description", 'systemPrompt', "system_prompt", 'bundles', "bundles", 'dataTables', "data_tables", 'selfLearning', "self_learning") WHERE "plugin_id" IS NOT NULL;--> statement-breakpoint
UPDATE "tools" SET "upstream" = jsonb_build_object('name', "name", 'url', "url", 'transport', "transport") WHERE "plugin_id" IS NOT NULL AND "kind" = 'http';
