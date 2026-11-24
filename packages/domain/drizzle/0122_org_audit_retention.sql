ALTER TABLE "workspace_settings" DROP CONSTRAINT "workspace_settings_audit_retention_range";--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "audit_retention_days" integer DEFAULT 730 NOT NULL;--> statement-breakpoint
-- Each existing organization keeps the longest retention of its workspaces (one with no settings row
-- had 90 days), so nothing is pruned earlier than before. New organizations start at 730 days.
UPDATE "organizations" o SET "audit_retention_days" = w."days"
FROM (
  SELECT ws."organization_id", max(coalesce(s."audit_retention_days", 90)) AS "days"
  FROM "workspaces" ws LEFT JOIN "workspace_settings" s ON s."workspace_id" = ws."id"
  GROUP BY ws."organization_id"
) w
WHERE w."organization_id" = o."id";--> statement-breakpoint
ALTER TABLE "workspace_settings" DROP COLUMN "audit_retention_days";--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_audit_retention_range" CHECK ("organizations"."audit_retention_days" between 1 and 3650);