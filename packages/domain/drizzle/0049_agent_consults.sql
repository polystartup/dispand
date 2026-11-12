CREATE TABLE "agent_consults" (
	"agent_id" text NOT NULL,
	"consulted_id" text NOT NULL,
	"ask" boolean DEFAULT false NOT NULL,
	CONSTRAINT "agent_consults_agent_id_consulted_id_pk" PRIMARY KEY("agent_id","consulted_id")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_consults" ADD CONSTRAINT "agent_consults_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_consults" ADD CONSTRAINT "agent_consults_consulted_id_agents_id_fk" FOREIGN KEY ("consulted_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_consults_consulted_idx" ON "agent_consults" USING btree ("consulted_id");