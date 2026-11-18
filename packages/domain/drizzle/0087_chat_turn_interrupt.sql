ALTER TABLE "cloud_sessions" ADD COLUMN "turn_id" text;--> statement-breakpoint
ALTER TABLE "step_runs" ADD COLUMN "turn_id" text;--> statement-breakpoint
ALTER TABLE "step_runs" ADD COLUMN "interruptible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "step_runs" ADD COLUMN "interrupt_after_position" integer;--> statement-breakpoint
ALTER TABLE "step_runs" ADD COLUMN "codex_input_id" text;
