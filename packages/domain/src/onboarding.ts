import { and, count, eq, sql } from "drizzle-orm";
import { agents, harnesses, workflows, workflowVersions } from "./db/schema.ts";
import { authed, base } from "./rpc/context.ts";

const owner = base.use(authed);

/**
 * What the owner has set up, and whether Home still shows the first-launch choices: until the
 * guided tour is completed (not built yet: never) or an agent and a manual workflow exist.
 * A manual workflow is one whose current version has a manual trigger.
 */
const status = owner.handler(async ({ context }) => {
  const has = async (table: typeof harnesses | typeof agents) => {
    const [row] = await context.db.select({ n: count() }).from(table).where(eq(table.ownerId, context.ownerId));
    return (row?.n ?? 0) > 0;
  };
  const manual = await context.db
    .select({ type: sql<string>`${workflowVersions.def}->'trigger'->>'type'` })
    .from(workflows)
    .innerJoin(workflowVersions, and(eq(workflowVersions.workflowId, workflows.id), eq(workflowVersions.version, workflows.currentVersion)))
    .where(eq(workflows.ownerId, context.ownerId));
  const hasManualWorkflow = manual.some((w) => w.type === "manual");
  const [hasHarness, hasAgent] = await Promise.all([has(harnesses), has(agents)]);
  return { showFirstLaunch: !(hasAgent && hasManualWorkflow), hasHarness, hasAgent, hasManualWorkflow };
});

export const onboarding = { status };
