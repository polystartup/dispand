-- Data belongs to the workspace. Every row goes to the install's only workspace; with several, a root
-- goes to its run's workspace, a Job's file outside any table to its Job's, and the rest goes. The files limit moves to the organization, which
-- counts the bytes of its attachments: a trigger keeps the count and refuses an insert past the limit.
ALTER TABLE "workspace_settings" DROP CONSTRAINT "workspace_settings_files_limit_range";--> statement-breakpoint
ALTER TABLE "workspace_settings" DROP COLUMN "files_limit_mib";--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "roots" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "tables" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "files_quota_bytes" bigint DEFAULT 10737418240;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "files_used_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "tables" SET "workspace_id" = (SELECT min("id") FROM "workspaces" HAVING count(*) = 1);--> statement-breakpoint
UPDATE "events" SET "workspace_id" = (SELECT min("id") FROM "workspaces" HAVING count(*) = 1);--> statement-breakpoint
UPDATE "attachments" a SET "workspace_id" = coalesce(
  (SELECT r."workspace_id" FROM "runs" r WHERE r."id" = a."job_id" AND a."table_id" IS NULL),
  (SELECT min("id") FROM "workspaces" HAVING count(*) = 1));--> statement-breakpoint
UPDATE "memories" SET "workspace_id" = (SELECT min("id") FROM "workspaces" HAVING count(*) = 1);--> statement-breakpoint
UPDATE "roots" o SET "workspace_id" = coalesce(
  (SELECT r."workspace_id" FROM "runs" r WHERE r."id" = o."run_id"),
  (SELECT min(r."workspace_id") FROM "runs" r WHERE r."root_id" = o."id"),
  (SELECT min("id") FROM "workspaces" HAVING count(*) = 1));--> statement-breakpoint
DELETE FROM "events" WHERE "workspace_id" IS NULL;--> statement-breakpoint
DELETE FROM "attachments" WHERE "workspace_id" IS NULL;--> statement-breakpoint
DELETE FROM "memories" WHERE "workspace_id" IS NULL;--> statement-breakpoint
DELETE FROM "fields" WHERE "references_table_id" IN (SELECT "id" FROM "tables" WHERE "workspace_id" IS NULL);--> statement-breakpoint
DELETE FROM "tables" WHERE "workspace_id" IS NULL;--> statement-breakpoint
-- No run names these: an event that did is gone above.
DELETE FROM "roots" WHERE "workspace_id" IS NULL;--> statement-breakpoint
UPDATE "organizations" o SET "files_used_bytes" = (SELECT coalesce(sum(a."size"), 0) FROM "attachments" a JOIN "workspaces" w ON w."id" = a."workspace_id" WHERE w."organization_id" = o."id");--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "roots" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tables" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roots" ADD CONSTRAINT "roots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- In the same transaction as the row, cascades included: the count needs no reconciling. The
-- organization row's lock serializes uploads; a delete is never refused, so cleanup works past a lowered limit.
CREATE FUNCTION "dispand_files_usage"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE "organizations" SET "files_used_bytes" = "files_used_bytes" + NEW."size"
      WHERE "id" = (SELECT "organization_id" FROM "workspaces" WHERE "id" = NEW."workspace_id")
        AND ("files_quota_bytes" IS NULL OR "files_used_bytes" + NEW."size" <= "files_quota_bytes");
    IF NOT FOUND THEN
      RAISE EXCEPTION 'files quota exceeded' USING ERRCODE = 'P0D02';
    END IF;
    RETURN NEW;
  END IF;
  UPDATE "organizations" SET "files_used_bytes" = "files_used_bytes" - OLD."size"
    WHERE "id" = (SELECT "organization_id" FROM "workspaces" WHERE "id" = OLD."workspace_id");
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "attachments_files_usage" AFTER INSERT OR DELETE ON "attachments" FOR EACH ROW EXECUTE FUNCTION "dispand_files_usage"();
