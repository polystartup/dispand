CREATE TABLE "agent_skills" (
	"agent_id" text NOT NULL,
	"package_id" text NOT NULL,
	CONSTRAINT "agent_skills_agent_id_package_id_pk" PRIMARY KEY("agent_id","package_id")
);
--> statement-breakpoint
CREATE TABLE "agent_tools" (
	"agent_id" text NOT NULL,
	"tool_id" text NOT NULL,
	CONSTRAINT "agent_tools_agent_id_tool_id_pk" PRIMARY KEY("agent_id","tool_id")
);
--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_package_id_skill_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."skill_packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_skills_package_idx" ON "agent_skills" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "agent_tools_tool_idx" ON "agent_tools" USING btree ("tool_id");