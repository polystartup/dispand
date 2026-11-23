import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { withIdentity } from "../auth.ts";
import { recordAudit } from "../audit/record.ts";
import { user } from "../db/schema.ts";
import { message } from "../messages/index.ts";
import { authed, base } from "../rpc/context.ts";
import { StorableText } from "../text.ts";

/** A person's own, never a Job's: Q4's escalation reads it, nothing writes it for them. */
const self = base.use(authed).use(({ context, next }) => {
  if (context.job) throw new ORPCError("FORBIDDEN", message("auth.ownerOnly"));
  return next();
});

/** What the person knows and can answer, at most 1,000 characters (the column's check says the same). Empty clears it. */
const Description = z.string().trim().pipe(StorableText(1000));

export const get = self.handler(async ({ context }) => {
  const [row] = await context.db.select({ description: user.description }).from(user).where(eq(user.id, context.ownerId));
  return { description: row?.description ?? null };
});

export const update = self.input(z.object({ description: Description })).handler(async ({ context, input }) => {
  const description = input.description || null;
  const userId = context.ownerId;
  // Better Auth's table is written through authDb; the audit row, with no text, in db.
  await withIdentity(context, async (tx) => {
    await tx.update(user).set({ description }).where(eq(user.id, userId));
  }, (tx) => recordAudit(tx, { ownerId: userId, actor: { type: "user", userId }, action: "profile.updated", resource: { type: "user", id: userId } }));
  return { description };
});

export const profile = { get, update };
