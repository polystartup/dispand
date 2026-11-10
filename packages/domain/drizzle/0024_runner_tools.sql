ALTER TABLE "tools" ALTER COLUMN "url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tools" ALTER COLUMN "transport" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "tools" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "runner_id" text;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "runner_tool" text;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE no action ON UPDATE no action;