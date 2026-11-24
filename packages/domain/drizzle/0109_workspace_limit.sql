-- One owner per organization: an install with several keeps one (plain rewrite, the others become members).
UPDATE "organization_members" m SET "role" = 'member'
WHERE m."role" = 'owner' AND EXISTS (
  SELECT 1 FROM "organization_members" o WHERE o."organization_id" = m."organization_id" AND o."role" = 'owner' AND o."user_id" < m."user_id"
);--> statement-breakpoint
CREATE UNIQUE INDEX "organization_members_one_owner_idx" ON "organization_members" USING btree ("organization_id") WHERE "organization_members"."role" = 'owner';--> statement-breakpoint
-- The install's workspace limit. Only this migration defines the function: a database adapter may
-- replace its body, and a later migration re-creating it would undo that. Workspaces already there stay.
CREATE FUNCTION dispand_workspace_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('dispand:workspaces'));
  IF EXISTS (SELECT 1 FROM workspaces) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0D01', MESSAGE = 'workspace.selfHostedLimit';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER workspaces_limit BEFORE INSERT ON workspaces FOR EACH ROW EXECUTE FUNCTION dispand_workspace_limit();
