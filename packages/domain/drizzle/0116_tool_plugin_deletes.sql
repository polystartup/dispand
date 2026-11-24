ALTER TABLE "plugin_conflicts" DROP CONSTRAINT "plugin_conflicts_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "plugins" DROP CONSTRAINT "plugins_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "tools" DROP CONSTRAINT "tools_owner_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "plugin_conflicts" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "plugins" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tools" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_conflicts" ADD CONSTRAINT "plugin_conflicts_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;