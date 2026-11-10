CREATE TABLE "marketplaces" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"built_in" boolean DEFAULT false NOT NULL,
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"synced_at" timestamp,
	"sync_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "marketplaces_owner_url" UNIQUE("owner_id","url")
);
--> statement-breakpoint
CREATE TABLE "plugins" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"marketplace_id" text NOT NULL,
	"entry_name" text NOT NULL,
	"url" text NOT NULL,
	"sha" text NOT NULL,
	"components" jsonb NOT NULL,
	"not_imported" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"installed_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "plugins_owner_entry" UNIQUE("owner_id","marketplace_id","entry_name")
);
--> statement-breakpoint
ALTER TABLE "marketplaces" ADD CONSTRAINT "marketplaces_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_marketplace_id_marketplaces_id_fk" FOREIGN KEY ("marketplace_id") REFERENCES "public"."marketplaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_packages" ADD CONSTRAINT "skill_packages_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Every existing owner gets the built-in marketplaces (new owners get them at setup).
INSERT INTO "marketplaces" ("id", "owner_id", "name", "url", "built_in")
SELECT 'mkt_' || replace(gen_random_uuid()::text, '-', ''), u."id", b."name", b."url", true
FROM "user" u
CROSS JOIN (VALUES
	('claude-plugins-official', 'https://github.com/anthropics/claude-plugins-official.git'),
	('anthropic-agent-skills', 'https://github.com/anthropics/skills.git')
) AS b("name", "url");
