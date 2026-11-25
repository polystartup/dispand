-- The person trigger names its tables: it also fires inside the purge function, whose search_path is pinned.
CREATE OR REPLACE FUNCTION dispand_person_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.runs WHERE agent_id IN (SELECT id FROM public.agents WHERE owner_id = OLD.id AND built_in = 'assistant');
  DELETE FROM public.agents WHERE owner_id = OLD.id AND built_in = 'assistant';
  RETURN OLD;
END $$;--> statement-breakpoint
-- Permanently deletes one archived person, with its Audit rows, as the nightly purge's only way to do
-- it. It runs as its owner (a database adapter's migration login may bypass row security), so it
-- checks inside that the person may be purged: archived, in no organization, and archived longer
-- than the archiving organization's retention, on the database's own clock. Anyone else: false.
CREATE FUNCTION dispand_purge_person(p_user_id text, p_trace_id text DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_org text;
BEGIN
  DELETE FROM public."user" u
  WHERE u.id = p_user_id
    AND u.archived_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = u.id)
    AND u.archived_at < pg_catalog.now() - pg_catalog.make_interval(days => coalesce(
      (SELECT o.person_retention_days FROM public.organizations o WHERE o.id = u.archived_by), 90))
  RETURNING u.archived_by INTO v_org;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO public.audit (id, workspace_id, owner_id, actor, action, resource_type, resource_id, result, details, trace_id)
  SELECT 'aud_' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''), w.id, NULL,
    '{"type":"scheduler"}'::jsonb, 'workspace.personPurged', 'workspace', w.id, 'ok',
    pg_catalog.jsonb_build_object('userId', p_user_id), p_trace_id
  FROM public.workspaces w WHERE w.organization_id = v_org;
  RETURN true;
END $$;
--> statement-breakpoint
-- Only its owner calls it; a database adapter grants EXECUTE to the login that runs the purge.
REVOKE ALL ON FUNCTION dispand_purge_person(text, text) FROM PUBLIC;
