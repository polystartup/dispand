ALTER TABLE "agents" DROP CONSTRAINT "agents_plugin_id_plugins_id_fk";
--> statement-breakpoint
ALTER TABLE "skill_packages" DROP CONSTRAINT "skill_packages_plugin_id_plugins_id_fk";
--> statement-breakpoint
ALTER TABLE "tools" DROP CONSTRAINT "tools_plugin_id_plugins_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_packages" ADD CONSTRAINT "skill_packages_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;