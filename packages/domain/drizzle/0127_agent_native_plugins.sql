CREATE TABLE "agent_native_plugins" (
	"agent_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	CONSTRAINT "agent_native_plugins_agent_id_plugin_id_pk" PRIMARY KEY("agent_id","plugin_id")
);
--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "native_digest" text;--> statement-breakpoint
ALTER TABLE "agent_native_plugins" ADD CONSTRAINT "agent_native_plugins_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_native_plugins" ADD CONSTRAINT "agent_native_plugins_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_native_plugins_plugin_idx" ON "agent_native_plugins" USING btree ("plugin_id");