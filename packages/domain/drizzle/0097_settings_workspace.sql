-- Settings belong to the workspace. Every row goes to the install's only workspace; with none or
-- several there is no workspace to give them, and they go. One workspace keeps one row.
ALTER TABLE "workspace_settings" ADD COLUMN "workspace_id" text;--> statement-breakpoint
UPDATE "workspace_settings" SET "workspace_id" = (SELECT min("id") FROM "workspaces" HAVING count(*) = 1);--> statement-breakpoint
DELETE FROM "workspace_settings" WHERE "workspace_id" IS NULL OR "owner_id" <> (SELECT min("owner_id") FROM "workspace_settings");--> statement-breakpoint
ALTER TABLE "workspace_settings" DROP COLUMN "owner_id";--> statement-breakpoint
ALTER TABLE "workspace_settings" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD PRIMARY KEY ("workspace_id");--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
