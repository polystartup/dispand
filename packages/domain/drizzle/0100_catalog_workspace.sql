-- The catalog belongs to the workspace. Every row goes to the install's only workspace; with
-- several, a harness goes to its runner's workspace, or to that of an agent using it, and the rest
-- goes. Rows that then share a re-keyed key keep one: the organization owner's, else the lowest id. OAuth grants made when a
-- tool was one person's are cleared, and its actions ask again: connecting it again shares the account with the workspace.
ALTER TABLE "marketplaces" DROP CONSTRAINT "marketplaces_owner_url";--> statement-breakpoint
ALTER TABLE "plugins" DROP CONSTRAINT "plugins_owner_entry";--> statement-breakpoint
ALTER TABLE "skill_packages" DROP CONSTRAINT "skill_packages_owner_name";--> statement-breakpoint
DROP INDEX "plugins_owner_generated_idx";--> statement-breakpoint
DROP INDEX "tools_owner_name_idx";--> statement-breakpoint
DROP INDEX "skill_packages_one_built_in_idx";--> statement-breakpoint
-- A deleted plugin's tables become their owner's own and may then share a name: renamed below, after their id, which no other name holds.
DROP INDEX "tables_owner_name_idx";--> statement-breakpoint
ALTER TABLE "harnesses" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "marketplaces" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "skill_packages" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "workspace_id" text;--> statement-breakpoint
UPDATE "marketplaces" SET "workspace_id" = (SELECT min("id") FROM "workspaces" HAVING count(*) = 1);--> statement-breakpoint
UPDATE "plugins" SET "workspace_id" = (SELECT min("id") FROM "workspaces" HAVING count(*) = 1);--> statement-breakpoint
UPDATE "tools" SET "workspace_id" = (SELECT min("id") FROM "workspaces" HAVING count(*) = 1);--> statement-breakpoint
UPDATE "skill_packages" SET "workspace_id" = (SELECT min("id") FROM "workspaces" HAVING count(*) = 1);--> statement-breakpoint
UPDATE "harnesses" h SET "workspace_id" = coalesce(
  (SELECT r."workspace_id" FROM "runners" r WHERE r."id" = h."runner_id"),
  (SELECT min(a."workspace_id") FROM "agents" a WHERE a."harness_id" = h."id"),
  (SELECT min("id") FROM "workspaces" HAVING count(*) = 1));--> statement-breakpoint
DELETE FROM "agent_tools" WHERE "tool_id" IN (SELECT "id" FROM "tools" WHERE "workspace_id" IS NULL);--> statement-breakpoint
DELETE FROM "agent_skills" WHERE "package_id" IN (SELECT "id" FROM "skill_packages" WHERE "workspace_id" IS NULL);--> statement-breakpoint
DELETE FROM "tools" WHERE "workspace_id" IS NULL;--> statement-breakpoint
DELETE FROM "skill_packages" WHERE "workspace_id" IS NULL;--> statement-breakpoint
DELETE FROM "plugins" WHERE "workspace_id" IS NULL;--> statement-breakpoint
DELETE FROM "marketplaces" WHERE "workspace_id" IS NULL;--> statement-breakpoint
DELETE FROM "harnesses" WHERE "workspace_id" IS NULL;--> statement-breakpoint
CREATE TEMP TABLE "keeper" AS SELECT w."id" AS "workspace_id", m."user_id" FROM "workspaces" w JOIN "organization_members" m ON m."organization_id" = w."organization_id" AND m."role" = 'owner';--> statement-breakpoint
CREATE TEMP TABLE "losing" ("id" text);--> statement-breakpoint
INSERT INTO "losing" SELECT "id" FROM (SELECT "id", row_number() OVER (PARTITION BY "workspace_id", "url" ORDER BY ("workspace_id", "owner_id") NOT IN (SELECT * FROM "keeper"), "id") AS "n" FROM "marketplaces") r WHERE "n" > 1;--> statement-breakpoint
DELETE FROM "plugins" WHERE "marketplace_id" IN (SELECT "id" FROM "losing");--> statement-breakpoint
DELETE FROM "marketplaces" WHERE "id" IN (SELECT "id" FROM "losing");--> statement-breakpoint
DELETE FROM "losing";--> statement-breakpoint
INSERT INTO "losing" SELECT "id" FROM (SELECT "id", row_number() OVER (PARTITION BY "workspace_id", "marketplace_id", "entry_name" ORDER BY ("workspace_id", "owner_id") NOT IN (SELECT * FROM "keeper"), "id") AS "n" FROM "plugins" WHERE "marketplace_id" IS NOT NULL AND "entry_name" IS NOT NULL) r WHERE "n" > 1;--> statement-breakpoint
INSERT INTO "losing" SELECT "id" FROM (SELECT "id", row_number() OVER (PARTITION BY "workspace_id", "name" ORDER BY ("workspace_id", "owner_id") NOT IN (SELECT * FROM "keeper"), "id") AS "n" FROM "plugins" WHERE "source" = 'generated') r WHERE "n" > 1;--> statement-breakpoint
DELETE FROM "plugins" WHERE "id" IN (SELECT "id" FROM "losing");--> statement-breakpoint
DELETE FROM "losing";--> statement-breakpoint
INSERT INTO "losing" SELECT "id" FROM (SELECT "id", row_number() OVER (PARTITION BY "workspace_id", coalesce("plugin_id", ''), lower("name") ORDER BY ("workspace_id", "owner_id") NOT IN (SELECT * FROM "keeper"), "id") AS "n" FROM "tools") r WHERE "n" > 1;--> statement-breakpoint
DELETE FROM "agent_tools" WHERE "tool_id" IN (SELECT "id" FROM "losing");--> statement-breakpoint
DELETE FROM "tools" WHERE "id" IN (SELECT "id" FROM "losing");--> statement-breakpoint
DELETE FROM "losing";--> statement-breakpoint
INSERT INTO "losing" SELECT "id" FROM (SELECT "id", row_number() OVER (PARTITION BY "workspace_id", "name" ORDER BY ("workspace_id", "owner_id") NOT IN (SELECT * FROM "keeper"), "id") AS "n" FROM "skill_packages") r WHERE "n" > 1;--> statement-breakpoint
DELETE FROM "agent_skills" WHERE "package_id" IN (SELECT "id" FROM "losing");--> statement-breakpoint
DELETE FROM "skill_packages" WHERE "id" IN (SELECT "id" FROM "losing");--> statement-breakpoint
DELETE FROM "losing";--> statement-breakpoint
INSERT INTO "losing" SELECT "id" FROM (SELECT "id", row_number() OVER (PARTITION BY "workspace_id" ORDER BY ("workspace_id", "owner_id") NOT IN (SELECT * FROM "keeper"), "id") AS "n" FROM "skill_packages" WHERE "built_in") r WHERE "n" > 1;--> statement-breakpoint
DELETE FROM "agent_skills" WHERE "package_id" IN (SELECT "id" FROM "losing");--> statement-breakpoint
DELETE FROM "skill_packages" WHERE "id" IN (SELECT "id" FROM "losing");--> statement-breakpoint
DROP TABLE "losing";--> statement-breakpoint
DROP TABLE "keeper";--> statement-breakpoint
UPDATE "agent_tools" SET "unasked" = '[]', "strict_target" = NULL WHERE "tool_id" IN (SELECT "id" FROM "tools" WHERE "auth" = 'oauth');--> statement-breakpoint
-- A new revision is a new permission target: grants remembered for a run or given with a skill no longer match.
UPDATE "tools" SET "oauth_sealed" = NULL, "oauth_status" = 'authorize', "oauth_state_hash" = NULL, "oauth_client_id" = NULL, "permission_revision" = "permission_revision" + 1 WHERE "auth" = 'oauth';--> statement-breakpoint
ALTER TABLE "harnesses" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "marketplaces" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "plugins" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_packages" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tools" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "harnesses" ADD CONSTRAINT "harnesses_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplaces" ADD CONSTRAINT "marketplaces_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_packages" ADD CONSTRAINT "skill_packages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
UPDATE "tables" t SET "name" = left(t."name", 97 - length(t."id")) || ' (' || t."id" || ')' FROM (SELECT "id", row_number() OVER (PARTITION BY "owner_id", coalesce("plugin_id", ''), lower("name") ORDER BY "plugin_component" NULLS FIRST, "id") AS "n" FROM "tables") r WHERE r."id" = t."id" AND r."n" > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "tables_owner_name_idx" ON "tables" USING btree ("owner_id",coalesce("plugin_id", ''),lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "plugins_workspace_generated_idx" ON "plugins" USING btree ("workspace_id","name") WHERE "plugins"."source" = 'generated';--> statement-breakpoint
CREATE UNIQUE INDEX "tools_workspace_name_idx" ON "tools" USING btree ("workspace_id",coalesce("plugin_id", ''),lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "skill_packages_one_built_in_idx" ON "skill_packages" USING btree ("workspace_id") WHERE "skill_packages"."built_in";--> statement-breakpoint
ALTER TABLE "marketplaces" ADD CONSTRAINT "marketplaces_workspace_url" UNIQUE("workspace_id","url");--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_workspace_entry" UNIQUE("workspace_id","marketplace_id","entry_name");--> statement-breakpoint
ALTER TABLE "skill_packages" ADD CONSTRAINT "skill_packages_workspace_name" UNIQUE("workspace_id","name");
