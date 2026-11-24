CREATE TABLE "agent_escalations" (
	"agent_id" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "agent_escalations_agent_id_user_id_pk" PRIMARY KEY("agent_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "escalate_mode" text DEFAULT 'disabled' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "prefer_agents" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_escalations" ADD CONSTRAINT "agent_escalations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_escalations" ADD CONSTRAINT "agent_escalations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_escalations_user_idx" ON "agent_escalations" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_escalate_mode_check" CHECK ("agents"."escalate_mode" in ('disabled', 'auto', 'whitelist'));--> statement-breakpoint
-- Existing agents keep today's behaviour: their questions go to their creator, now a whitelist holding them.
UPDATE "agents" SET "escalate_mode" = 'whitelist';--> statement-breakpoint
INSERT INTO "agent_escalations" ("agent_id", "user_id") SELECT "id", "owner_id" FROM "agents" WHERE "owner_id" IS NOT NULL;--> statement-breakpoint
-- A plugin's values gain the routing fields as the agent has them now, so no update reads them as changed by its owner.
UPDATE "agents" SET "upstream" = "upstream" || jsonb_build_object('escalateMode', 'whitelist', 'preferAgents', false) WHERE "upstream" IS NOT NULL;
