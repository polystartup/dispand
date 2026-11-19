CREATE TABLE "workspace_members" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id"),
	CONSTRAINT "workspace_members_role_check" CHECK ("workspace_members"."role" in ('manager', 'member'))
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "workspace_id" text;
--> statement-breakpoint
UPDATE agents SET workspace_id = (
  SELECT w.id FROM workspaces w
  JOIN organization_members m ON m.organization_id = w.organization_id
  WHERE m.user_id = agents.owner_id AND m.role = 'owner'
);
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "workspace_id" text;
--> statement-breakpoint
UPDATE runs SET workspace_id = (
  SELECT w.id FROM workspaces w
  JOIN organization_members m ON m.organization_id = w.organization_id
  WHERE m.user_id = runs.owner_id AND m.role = 'owner'
);
--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "workspace_id" text;
--> statement-breakpoint
UPDATE workflows SET workspace_id = (
  SELECT w.id FROM workspaces w
  JOIN organization_members m ON m.organization_id = w.organization_id
  WHERE m.user_id = workflows.owner_id AND m.role = 'owner'
);
--> statement-breakpoint
ALTER TABLE "workflows" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;