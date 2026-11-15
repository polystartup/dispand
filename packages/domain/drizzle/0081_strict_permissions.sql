ALTER TABLE "agent_skill_tool_permissions" ADD COLUMN "strict_target" text;--> statement-breakpoint
ALTER TABLE "agent_tools" ADD COLUMN "strict_target" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_packages" ADD COLUMN "fingerprint" text;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "strict_permissions" boolean DEFAULT false NOT NULL;