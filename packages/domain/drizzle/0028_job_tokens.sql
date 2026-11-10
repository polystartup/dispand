ALTER TABLE "runs" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "token_sealed" text;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_token_hash_unique" UNIQUE("token_hash");