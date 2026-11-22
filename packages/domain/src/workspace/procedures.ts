import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { acceptInvitation, invitation, invitations, invite, registerInvitation, registrationPreview, revokeInvitation } from "./invitations.ts";
import { managed, mine, people, removePerson } from "./people.ts";
import { reviewSignals } from "../assistant/review.ts";
import { DEFAULT_RETENTION_DAYS } from "../audit/sweep.ts";
import { strictPermissionsOf } from "../agents/tool-ask.ts";
import { agents, triggers, workspaceSettings } from "../db/schema.ts";
import { checkpointOf } from "../engine/roots.ts";
import { filesLimitOf } from "../data/files.ts";
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

/** How many MiB of files the whole install keeps (`data/files.ts` `keepJobFiles`): 1 MiB to 1 TiB. */
export const FilesLimitMib = z.number().int().min(1).max(1_048_576);

/** The install's limit on its files, in MiB (10 GiB until set). */
const filesLimit = owner.handler(async ({ context }) => ({ mib: await filesLimitOf(context.db, context.ownerId) }));

/**
 * Sets the install's limit on its files. Files already kept stay: a lower limit only refuses the
 * next tool results that would pass it. The owner's only: raising it lets agents fill the disk.
 */
const setFilesLimit = owner.input(z.object({ mib: FilesLimitMib })).handler(async ({ input, context }) => {
  await context.db
    .insert(workspaceSettings)
    .values({ ownerId: context.ownerId, filesLimitMib: input.mib })
    .onConflictDoUpdate({ target: workspaceSettings.ownerId, set: { filesLimitMib: input.mib } });
  return { mib: input.mib };
});

/** Whether strict permissions are on (design 6.6; off until set). */
const strictPermissions = owner.handler(async ({ context }) => ({ strict: await strictPermissionsOf(context.db, context.ownerId) }));

/**
 * Turns strict permissions on or off: on, a remembered choice holds only while its tool's
 * actions, its plugin's commit, its skill's files and its agent's configuration are as they were
 * when it was given (`agents/tool-ask.ts`); off, only its tool's address and transport count.
 * The owner's only: turning it off widens what agents may run unasked, so no tool or proposal can ask for it (`NOT_TOOLS`).
 */
const setStrictPermissions = owner.input(z.object({ strict: z.boolean() })).handler(async ({ input, context }) => {
  await context.db
    .insert(workspaceSettings)
    .values({ ownerId: context.ownerId, strictPermissions: input.strict })
    .onConflictDoUpdate({ target: workspaceSettings.ownerId, set: { strictPermissions: input.strict } });
  // Grants that stop holding leave the sessions already running too.
  if (input.strict) await context.engine.narrowOwnerSessions(context.ownerId, context.db);
  return { strict: input.strict };
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

export const workspace = { invite, invitations, invitation, acceptInvitation, registerInvitation, registrationPreview, revokeInvitation, mine, managed, people, removePerson, checkpoint, setCheckpoint, auditRetention, setAuditRetention, filesLimit, setFilesLimit, strictPermissions, setStrictPermissions, review };
