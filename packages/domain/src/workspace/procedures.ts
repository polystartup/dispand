import { ORPCError } from "@orpc/server";
import { message } from "../messages/index.ts";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { acceptInvitation, invitation, invitations, invite, registerInvitation, registrationPreview, revokeInvitation } from "./invitations.ts";
import { lifecycle } from "./lifecycle.ts";
import { managed, mine, people, removePerson } from "./people.ts";
import { reviewSignals } from "../assistant/review.ts";
import { strictPermissionsOf } from "../agents/tool-ask.ts";
import { agents, organizations, triggers, workspaceSettings } from "../db/schema.ts";
import { checkpointOf } from "../engine/roots.ts";
import { filesLimitOf } from "../data/files.ts";
import { base, manager, member } from "../rpc/context.ts";
import { DEFAULT_TIMEZONE } from "../workflows/schedule.ts";

const reader = base.use(member);
const writer = base.use(manager);

/** How many Jobs of one root cause go before a person is asked to let them go on (design 6.1). */
export const Checkpoint = z.number().int().min(1).max(100_000);

/** The workspace's checkpoint. */
const checkpoint = reader.handler(async ({ context }) => ({ checkpoint: await checkpointOf(context.db, context.access.workspaceId) }));

/**
 * Sets the checkpoint. Each root's next Job is counted against it as it is then: lowering it
 * pauses a root already past it at its next Job; raising it lets the roots going now go further.
 * A root already paused waits for its answer either way.
 */
const setCheckpoint = writer.input(z.object({ checkpoint: Checkpoint })).handler(async ({ input, context }) => {
  await context.db
    .insert(workspaceSettings)
    .values({ workspaceId: context.access.workspaceId, checkpoint: input.checkpoint })
    .onConflictDoUpdate({ target: workspaceSettings.workspaceId, set: { checkpoint: input.checkpoint } });
  return { checkpoint: input.checkpoint };
});

/** How many MiB of files the organization keeps (`organizations.files_quota_bytes`): 1 MiB to 1 TiB. */
export const FilesLimitMib = z.number().int().min(1).max(1_048_576);

/** The organization's limit on its files, in MiB (10 GiB until set; null: no limit). */
const filesLimit = reader.handler(async ({ context }) => ({ mib: await filesLimitOf(context.db, context.access.workspaceId) }));

/**
 * Sets the organization's limit on its files, for all its workspaces. Files already kept stay: a
 * lower limit only refuses the next files that would pass it. The organization owner's only:
 * raising it lets agents fill the disk.
 */
const setFilesLimit = writer.input(z.object({ mib: FilesLimitMib })).handler(async ({ input, context }) => {
  // The organization's: its owner's only, whatever their workspace role.
  if (context.access.role !== "owner") throw new ORPCError("FORBIDDEN", message("auth.ownerOnly"));
  const { organizationId } = context.access;
  await context.db.update(organizations).set({ filesQuotaBytes: input.mib * 1024 * 1024 }).where(eq(organizations.id, organizationId));
  return { mib: input.mib };
});

/** Whether strict permissions are on (design 6.6; off until set). */
const strictPermissions = reader.handler(async ({ context }) => ({ strict: await strictPermissionsOf(context.db, context.access.workspaceId) }));

/**
 * Turns strict permissions on or off: on, a remembered choice holds only while its tool's
 * actions, its plugin's commit, its skill's files and its agent's configuration are as they were
 * when it was given (`agents/tool-ask.ts`); off, only its tool's address and transport count.
 * The owner's only: turning it off widens what agents may run unasked, so no tool or proposal can ask for it (`NOT_TOOLS`).
 */
const setStrictPermissions = writer.input(z.object({ strict: z.boolean() })).handler(async ({ input, context }) => {
  await context.db
    .insert(workspaceSettings)
    .values({ workspaceId: context.access.workspaceId, strictPermissions: input.strict })
    .onConflictDoUpdate({ target: workspaceSettings.workspaceId, set: { strictPermissions: input.strict } });
  // Grants that stop holding leave the sessions already running too.
  if (input.strict) await context.engine.narrowWorkspaceSessions(context.access.workspaceId, context.db);
  return { strict: input.strict };
});

/**
 * What could be better in the workspace (`assistant/review.ts`). Hours are read in the time zone
 * of the Assistant's review, which is the owner's once they turned it on.
 */
const review = reader.handler(async ({ context }) => {
  const [assistantReview] = await context.db
    .select({ config: triggers.config })
    .from(triggers)
    .innerJoin(agents, eq(agents.id, triggers.agentId))
    .where(and(eq(agents.ownerId, context.actorId), eq(agents.workspaceId, context.access.workspaceId), eq(triggers.builtIn, "review"), eq(agents.builtIn, "assistant")));
  const timezone = assistantReview?.config.kind === "schedule" ? assistantReview.config.timezone : DEFAULT_TIMEZONE;
  return reviewSignals(context.db, context.access.workspaceId, context.actorId, (context.now ?? (() => new Date()))(), timezone);
});

export const workspace = { invite, invitations, invitation, acceptInvitation, registerInvitation, registrationPreview, revokeInvitation, mine, managed, people, removePerson, checkpoint, setCheckpoint, filesLimit, setFilesLimit, strictPermissions, setStrictPermissions, review, ...lifecycle };
