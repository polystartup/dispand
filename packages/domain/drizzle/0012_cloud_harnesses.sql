ALTER TABLE "harnesses" ALTER COLUMN "runner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "harnesses" ALTER COLUMN "permission_mode" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "harnesses" ADD COLUMN "type" text DEFAULT 'cli' NOT NULL;--> statement-breakpoint
ALTER TABLE "harnesses" ADD COLUMN "base_url" text;--> statement-breakpoint
ALTER TABLE "harnesses" ADD COLUMN "api_key_sealed" text;--> statement-breakpoint
ALTER TABLE "harnesses" ADD COLUMN "system_prompt" text;--> statement-breakpoint
ALTER TABLE "harnesses" ADD COLUMN "max_tokens" integer;--> statement-breakpoint
ALTER TABLE "harnesses" ADD COLUMN "effort" text;--> statement-breakpoint
ALTER TABLE "harnesses" ADD COLUMN "temperature" double precision;