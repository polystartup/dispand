-- One Assistant per person and workspace. The index it replaces was stricter, so existing rows fit and keep their workspace.
DROP INDEX "agents_one_assistant_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "agents_one_assistant_idx" ON "agents" USING btree ("workspace_id","owner_id") WHERE "agents"."built_in" = 'assistant';