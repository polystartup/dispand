ALTER TABLE "runners" ADD COLUMN "workspace_id" text;--> statement-breakpoint
-- Preserve the workspace used by jobs and configured agents. When there is no such evidence,
-- use the owner's workspaces, then the installation's sole workspace.
WITH candidates (runner_id, workspace_id, priority) AS (
  SELECT h.runner_id, a.workspace_id, 1 FROM agents a JOIN harnesses h ON h.id = a.harness_id
  WHERE h.runner_id IS NOT NULL
  UNION ALL
  SELECT s.runner_id, j.workspace_id, 1 FROM step_runs s JOIN runs j ON j.id = s.run_id WHERE s.runner_id IS NOT NULL
  UNION ALL
  SELECT r.id, w.id, 2 FROM runners r JOIN organization_members m ON m.user_id = r.owner_id AND m.role = 'owner'
  JOIN workspaces w ON w.organization_id = m.organization_id
  UNION ALL
  SELECT r.id, w.id, 3 FROM runners r CROSS JOIN (SELECT min(id) AS id FROM workspaces HAVING count(*) = 1) w
), ranked AS (
  SELECT *, min(priority) OVER (PARTITION BY runner_id) AS preferred FROM candidates
), placements AS (
  SELECT runner_id, min(workspace_id) AS workspace_id FROM ranked WHERE priority = preferred
  GROUP BY runner_id HAVING count(DISTINCT workspace_id) = 1
)
UPDATE runners SET workspace_id = p.workspace_id FROM placements p WHERE p.runner_id = runners.id;--> statement-breakpoint
DO $$
DECLARE unresolved text;
BEGIN
  IF to_regclass('public.dispand_runner_workspace_assignments') IS NOT NULL THEN
    UPDATE public.runners r SET workspace_id = a.workspace_id FROM public.dispand_runner_workspace_assignments a
    WHERE r.id = a.runner_id AND r.workspace_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM public.step_runs s JOIN public.runs j ON j.id = s.run_id
      WHERE s.runner_id = r.id AND s.status IN ('pending', 'running', 'waiting')
        AND j.status IN ('running', 'waiting') AND j.workspace_id <> a.workspace_id
    );
  END IF;
  SELECT string_agg(id, ', ' ORDER BY id) INTO unresolved FROM public.runners
  WHERE workspace_id IS NULL AND revoked_at IS NULL;
  IF unresolved IS NOT NULL THEN
    RAISE EXCEPTION 'Choose a workspace for each legacy runner before upgrading: %', unresolved
      USING HINT = 'See deploy/README.md, Existing runner placement. Active jobs must stay in their original workspace.';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_live_workspace" CHECK ("runners"."workspace_id" IS NOT NULL OR ("runners"."revoked_at" IS NOT NULL AND "runners"."token_hash" IS NULL));