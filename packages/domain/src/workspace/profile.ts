import { eq } from "drizzle-orm";
import { z } from "zod";
import { withIdentity } from "../auth.ts";
import { recordAuditAfter } from "../audit/record.ts";
import type { Db } from "../db/client.ts";
import { currentScope, eachScope, refusalOf, SYSTEM } from "../db/scope.ts";
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
  // Better Auth's table is written through authDb; the audit rows, with no text, in db once it is saved.
  await withIdentity(context, async (tx) => {
    await tx.update(user).set({ description }).where(eq(user.id, userId));
  }, async () => {});
  // A profile is the person's, not a workspace's: each workspace they can open gets its row, written
  // in that workspace's scope (`eachScope`); once, as is, on a single-tenant database, for them all.
  // None goes into an organization its install refuses.
  const openable = async (db: Db) => (await mine(db, userId)).filter(({ organizationId }) => !refusalOf(db, organizationId)).map(({ organizationId, workspaceId }) => ({ userId, organizationId, workspaceId }));
  await eachScope(context.db, openable, async () => {
    const pass = currentScope();
    const workspaceIds = pass && pass !== SYSTEM && pass.workspaceId ? [pass.workspaceId] : (await openable(context.db)).map((w) => w.workspaceId);
    for (const workspaceId of workspaceIds) await recordAuditAfter(context.db, { workspaceId, ownerId: userId, actor: { type: "user", userId }, action: "profile.updated", resource: { type: "user", id: userId } });
  });
  return { description };
});

export const profile = { get, update };
