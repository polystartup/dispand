-- Audit rows belong to a workspace and outlive the person they are filed under. Every row goes to
-- the install's only workspace; with several, the rows go.
ALTER TABLE "audit" DROP CONSTRAINT "audit_owner_id_user_id_fk";--> statement-breakpoint
DROP INDEX "audit_owner_at_idx";--> statement-breakpoint
DROP INDEX "audit_owner_job_idx";--> statement-breakpoint
DROP INDEX "audit_owner_action_idx";--> statement-breakpoint
ALTER TABLE "audit" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "audit" ADD COLUMN "workspace_id" text;--> statement-breakpoint
UPDATE "audit" SET "workspace_id" = (SELECT min("id") FROM "workspaces" HAVING count(*) = 1);--> statement-breakpoint
DELETE FROM "audit" WHERE "workspace_id" IS NULL;--> statement-breakpoint
ALTER TABLE "audit" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "audit" ADD CONSTRAINT "audit_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit" ADD CONSTRAINT "audit_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_workspace_at_idx" ON "audit" USING btree ("workspace_id","at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_workspace_job_idx" ON "audit" USING btree ("workspace_id","job_id","at");--> statement-breakpoint
CREATE INDEX "audit_workspace_action_idx" ON "audit" USING btree ("workspace_id","action","at");
