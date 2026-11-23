-- A table's name is unique in its workspace, not per person: a run finds the workspace's tables,
-- whoever made them. Of tables that would share a name (two people's, in one workspace), the
-- oldest by id keeps it and the others are renamed after their id, so no reference breaks.
UPDATE "tables" t SET "name" = t."name" || ' (' || t."id" || ')' FROM "tables" k
WHERE k."workspace_id" = t."workspace_id" AND coalesce(k."plugin_id", '') = coalesce(t."plugin_id", '') AND lower(k."name") = lower(t."name") AND k."id" < t."id";--> statement-breakpoint
DROP INDEX "tables_owner_name_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "tables_workspace_name_idx" ON "tables" USING btree ("workspace_id",coalesce("plugin_id", ''),lower("name"));
