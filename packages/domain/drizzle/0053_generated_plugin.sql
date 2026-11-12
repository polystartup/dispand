ALTER TABLE "plugins" ALTER COLUMN "marketplace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "plugins" ALTER COLUMN "entry_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "plugins" ALTER COLUMN "url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "plugins" ALTER COLUMN "sha" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "source" text DEFAULT 'marketplace' NOT NULL;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "created" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "plugin" text;--> statement-breakpoint
CREATE UNIQUE INDEX "plugins_owner_generated_idx" ON "plugins" USING btree ("owner_id","name") WHERE "plugins"."source" = 'generated';