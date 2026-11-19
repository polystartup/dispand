CREATE TABLE "chat_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"position" integer GENERATED ALWAYS AS IDENTITY (sequence name "chat_queue_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"owner_id" text NOT NULL,
	"run_id" text NOT NULL,
	"step_run_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"text" text NOT NULL,
	"skill_id" text,
	"files" jsonb,
	"error" text,
	"acked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_queue" ADD CONSTRAINT "chat_queue_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_queue" ADD CONSTRAINT "chat_queue_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_queue" ADD CONSTRAINT "chat_queue_step_run_id_step_runs_id_fk" FOREIGN KEY ("step_run_id") REFERENCES "public"."step_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_queue_step_idx" ON "chat_queue" USING btree ("step_run_id","position");--> statement-breakpoint
CREATE INDEX "chat_queue_run_idx" ON "chat_queue" USING btree ("run_id","position");