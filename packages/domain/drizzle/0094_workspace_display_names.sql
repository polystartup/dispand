ALTER TABLE "organizations" ADD COLUMN "name" text DEFAULT 'My organization' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "name" text DEFAULT 'Main workspace' NOT NULL;