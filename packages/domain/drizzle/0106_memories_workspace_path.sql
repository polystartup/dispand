-- A memory path is unique in its scope of a workspace, not per person: a Job reads the
-- workspace's memory, whoever wrote it. Of entries that would share a path (two people's, in one
-- workspace), the oldest by id stays; the others go with their revisions (upgrades are plain rewrites).
DELETE FROM "memories" m USING "memories" k
WHERE k."workspace_id" = m."workspace_id" AND k."scope" = m."scope" AND coalesce(k."table_id", k."agent_id", '') = coalesce(m."table_id", m."agent_id", '') AND k."path" = m."path" AND k."id" < m."id";--> statement-breakpoint
DROP INDEX "memories_scope_path_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "memories_scope_path_idx" ON "memories" USING btree ("workspace_id","scope",coalesce("table_id", "agent_id", ''),"path");
