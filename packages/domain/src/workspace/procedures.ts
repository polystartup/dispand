import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { reviewSignals } from "../assistant/review.ts";
import { DEFAULT_RETENTION_DAYS } from "../audit/sweep.ts";
import { agents, triggers, workspaceSettings } from "../db/schema.ts";
import { checkpointOf } from "../engine/roots.ts";
import { authed, base } from "../rpc/context.ts";
import { DEFAULT_TIMEZONE } from "../workflows/schedule.ts";

const owner = base.use(authed);

/** How many Jobs of one root cause go before a person is asked to let them go on (design 6.1). */
export const Checkpoint = z.number().int().min(1).max(100_000);

/** The workspace's checkpoint. */
const checkpoint = owner.handler(async ({ context }) => ({ checkpoint: await checkpointOf(context.db, context.ownerId) }));

/**
 * Sets the checkpoint. Each root's next Job is counted against it as it is then: lowering it
 * pauses a root already past it at its next Job; raising it lets the roots going now go further.
 * A root already paused waits for its answer either way.
 */
const setCheckpoint = owner.input(z.object({ checkpoint: Checkpoint })).handler(async ({ input, context }) => {
  await context.db
    .insert(workspaceSettings)
    .values({ ownerId: context.ownerId, checkpoint: input.checkpoint })
    .onConflictDoUpdate({ target: workspaceSettings.ownerId, set: { checkpoint: input.checkpoint } });
  return { checkpoint: input.checkpoint };
});

/** How many days Audit rows are kept (design 6.8). */
export const AuditRetentionDays = z.number().int().min(1).max(3650);

/** How many days the workspace keeps Audit rows (90 until set; `audit/sweep.ts` deletes older ones). */
const auditRetention = owner.handler(async ({ context }) => {
  const [settings] = await context.db.select({ days: workspaceSettings.auditRetentionDays }).from(workspaceSettings).where(eq(workspaceSettings.ownerId, context.ownerId));
  return { days: settings?.days ?? DEFAULT_RETENTION_DAYS };
});

/**
 * Sets how many days Audit rows are kept; the next hourly sweep deletes what is older. The
 * owner's only: shortening it erases the trail of what agents did, so it is no tool and no
 * proposal can ask for it (`NOT_TOOLS`).
 */
const setAuditRetention = owner.input(z.object({ days: AuditRetentionDays })).handler(async ({ input, context }) => {
  await context.db
    .insert(workspaceSettings)
    .values({ ownerId: context.ownerId, auditRetentionDays: input.days })
    .onConflictDoUpdate({ target: workspaceSettings.ownerId, set: { auditRetentionDays: input.days } });
  return { days: input.days };
});

/**
 * What could be better in the workspace (`assistant/review.ts`). Hours are read in the time zone
 * of the Assistant's review, which is the owner's once they turned it on.
 */
const review = owner.handler(async ({ context }) => {
  const [assistantReview] = await context.db
    .select({ config: triggers.config })
    .from(triggers)
    .innerJoin(agents, eq(agents.id, triggers.agentId))
    .where(and(eq(triggers.ownerId, context.ownerId), eq(triggers.builtIn, "review"), eq(agents.builtIn, "assistant")));
  const timezone = assistantReview?.config.kind === "schedule" ? assistantReview.config.timezone : DEFAULT_TIMEZONE;
  return reviewSignals(context.db, context.ownerId, (context.now ?? (() => new Date()))(), timezone);
});

export const workspace = { checkpoint, setCheckpoint, auditRetention, setAuditRetention, review };
