ALTER TABLE "runs" DROP CONSTRAINT "runs_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "agent_name" text;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;