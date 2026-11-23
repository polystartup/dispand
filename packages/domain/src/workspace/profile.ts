import { eq } from "drizzle-orm";
import { z } from "zod";
import { withIdentity } from "../auth.ts";
import { recordAudit } from "../audit/record.ts";
import { user } from "../db/schema.ts";
import { StorableText } from "../text.ts";
import { mine } from "./authorize.ts";
import { person } from "./people.ts";

/** What the person knows and can answer, at most 1,000 characters (the column's check says the same). Empty clears it. */
const Description = z.string().trim().pipe(StorableText(1000));

export const get = person.handler(async ({ context }) => {
  const [row] = await context.db.select({ description: user.description }).from(user).where(eq(user.id, context.ownerId));
  return { description: row?.description ?? null };
});

export const update = person.input(z.object({ description: Description })).handler(async ({ context, input }) => {
  const description = input.description || null;
  const userId = context.ownerId;
  // Better Auth's table is written through authDb; the audit row, with no text, in db.
  await withIdentity(context, async (tx) => {
    await tx.update(user).set({ description }).where(eq(user.id, userId));
  }, async (tx) => {
    // A profile is the person's, not a workspace's: each workspace they can open gets its row.
    for (const { workspaceId } of await mine(tx, userId)) await recordAudit(tx, { workspaceId, ownerId: userId, actor: { type: "user", userId }, action: "profile.updated", resource: { type: "user", id: userId } });
  });
  return { description };
});

export const profile = { get, update };
