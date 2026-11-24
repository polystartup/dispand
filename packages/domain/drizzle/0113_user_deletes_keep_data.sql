ALTER TABLE "attachments" DROP CONSTRAINT "attachments_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "fields" DROP CONSTRAINT "fields_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "marketplaces" DROP CONSTRAINT "marketplaces_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "memories" DROP CONSTRAINT "memories_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "rows" DROP CONSTRAINT "rows_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "runner_pairings" DROP CONSTRAINT "runner_pairings_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "skill_packages" DROP CONSTRAINT "skill_packages_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "tables" DROP CONSTRAINT "tables_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_versions" DROP CONSTRAINT "workflow_versions_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "fields" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "marketplaces" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rows" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runner_pairings" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_packages" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tables" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_versions" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "fields" ADD CONSTRAINT "fields_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplaces" ADD CONSTRAINT "marketplaces_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rows" ADD CONSTRAINT "rows_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_pairings" ADD CONSTRAINT "runner_pairings_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_packages" ADD CONSTRAINT "skill_packages_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;