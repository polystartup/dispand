-- Pages belong to a workspace. Every page goes to the install's only workspace; with several, pages
-- (and, by cascade, their widgets) go. A person's Home is now one per workspace.
DROP INDEX "pages_one_home_idx";--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "workspace_id" text;--> statement-breakpoint
UPDATE "pages" SET "workspace_id" = (SELECT min("id") FROM "workspaces" HAVING count(*) = 1);--> statement-breakpoint
DELETE FROM "pages" WHERE "workspace_id" IS NULL;--> statement-breakpoint
ALTER TABLE "pages" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pages_one_home_idx" ON "pages" USING btree ("workspace_id","owner_id") WHERE "pages"."kind" = 'home';
