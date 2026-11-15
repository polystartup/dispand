CREATE TABLE "agent_skill_tool_permissions" (
	"agent_id" text NOT NULL,
	"skill_package_id" text NOT NULL,
	"tool_id" text NOT NULL,
	"target" text NOT NULL,
	"unasked" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"denied" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "agent_skill_tool_permissions_agent_id_skill_package_id_tool_id_pk" PRIMARY KEY("agent_id","skill_package_id","tool_id")
);
--> statement-breakpoint
ALTER TABLE "agent_skill_tool_permissions" ADD CONSTRAINT "agent_skill_tool_permissions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill_tool_permissions" ADD CONSTRAINT "agent_skill_tool_permissions_skill_package_id_skill_packages_id_fk" FOREIGN KEY ("skill_package_id") REFERENCES "public"."skill_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill_tool_permissions" ADD CONSTRAINT "agent_skill_tool_permissions_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_skill_tool_permissions_package_idx" ON "agent_skill_tool_permissions" USING btree ("skill_package_id");--> statement-breakpoint
CREATE INDEX "agent_skill_tool_permissions_tool_idx" ON "agent_skill_tool_permissions" USING btree ("tool_id");