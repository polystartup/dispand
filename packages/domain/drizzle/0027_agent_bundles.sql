ALTER TABLE "agents" ADD COLUMN "bundles" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "data_tables" jsonb DEFAULT '"all"'::jsonb NOT NULL;