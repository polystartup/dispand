import { z } from "zod";
import { workspaceSettings } from "../db/schema.ts";
import { checkpointOf } from "../engine/roots.ts";
import { authed, base } from "../rpc/context.ts";

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

export const workspace = { checkpoint, setCheckpoint };
