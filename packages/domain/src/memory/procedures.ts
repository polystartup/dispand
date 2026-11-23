import { ORPCError } from "@orpc/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { agents, memories } from "../db/schema.ts";
import { ID as MAX_ID } from "@dispand/runner-protocol";
import { authed, base } from "../rpc/context.ts";
import { requireLegacyWorkspace } from "../workspace/access.ts";
import { type MemoryAuthor, MemoryEntryShape, type MemoryScope } from "./model.ts";
import {
  acceptMemory,
  memoryIndex,
  NOT_FOUND,
  type Refusal,
  removeMemoryById,
  restoreMemory,
  revertMemory,
  scopeExists,
  writeMemory,
} from "./store.ts";
import { external, message } from "../messages/index.ts";

// The owner's memory pages (design 6.5): every scope's entries, shown and written by a person.
// Not tools: agents get their own (`memory_read`, `memory_add`...), gated by their targets.

const owner = base.use(authed);

const ID = z.string().min(1).max(MAX_ID);

const Scope = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("workspace") }),
  z.object({ scope: z.literal("table"), tableId: ID }),
  z.object({ scope: z.literal("agent"), agentId: ID }),
]);

const Entry = z.object(MemoryEntryShape);

const PERSON: MemoryAuthor = { type: "user" };

function done<T extends { id: string }>(result: T | Refusal): T {
  if (!("error" in result)) return result;
  if (result.error === NOT_FOUND) throw new ORPCError("NOT_FOUND", message("memory.notFound"));
  if (result.say) throw new ORPCError("BAD_REQUEST", message(result.say.key, result.say.values));
  throw new ORPCError("BAD_REQUEST", external(result.error));
}

/** Each agent author's name, for the page (an agent deleted since has none). */
async function authorNames(db: Parameters<typeof scopeExists>[0], ownerId: string, authors: MemoryAuthor[]) {
  const ids = [...new Set(authors.flatMap((a) => (a.type === "agent" ? [a.agentId] : [])))];
  if (ids.length === 0) return new Map<string, { name: string; builtIn: "assistant" | null }>();
  const rows = await db.select({ id: agents.id, name: agents.name, builtIn: agents.builtIn }).from(agents).where(and(eq(agents.ownerId, ownerId), inArray(agents.id, ids)));
  return new Map(rows.map((r) => [r.id, { name: r.name, builtIn: r.builtIn }]));
}

const authorView = (a: MemoryAuthor, names: Map<string, { name: string; builtIn: "assistant" | null }>) =>
  a.type === "user" ? { type: "user" as const } : { type: "agent" as const, agentId: a.agentId, runId: a.runId, configure: a.configure, name: names.get(a.agentId)?.name ?? null, builtIn: names.get(a.agentId)?.builtIn ?? null };

/** A scope's index, its live entries and its removed ones. */
const list = owner.input(Scope).handler(async ({ input, context }) => {
  const where = input as MemoryScope;
  if (!(await scopeExists(context.db, context.ownerId, where))) throw new ORPCError("NOT_FOUND", message("memory.notFound"));
  const rows = await context.db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.ownerId, context.ownerId),
        eq(memories.scope, where.scope),
        where.scope === "table" ? eq(memories.tableId, where.tableId) : where.scope === "agent" ? eq(memories.agentId, where.agentId) : undefined,
      ),
    )
    .orderBy(asc(memories.path));
  const names = await authorNames(context.db, context.ownerId, rows.map((r) => r.author));
  const view = rows.map((r) => ({
    id: r.id,
    path: r.path,
    name: r.name,
    description: r.description,
    type: r.type,
    body: r.body,
    author: authorView(r.author, names),
    acceptedAt: r.acceptedAt,
    removedAt: r.removedAt,
    updatedAt: r.updatedAt,
  }));
  const entries = view.filter((e) => !e.removedAt);
  return { index: memoryIndex(entries), entries, removed: view.filter((e) => e.removedAt) };
});

/** Adds the entry at its path, or changes the one there: the person becomes its author. */
const write = owner
  .input(z.object({ where: Scope, entry: Entry }))
  .handler(async ({ input, context }) => done(await writeMemory(context.db, context.ownerId, await requireLegacyWorkspace(context), input.where as MemoryScope, input.entry, PERSON, "upsert")));

const remove = owner.input(z.object({ id: ID })).handler(async ({ input, context }) => done(await removeMemoryById(context.db, context.ownerId, input.id, PERSON)));

const accept = owner.input(z.object({ id: ID })).handler(async ({ input, context }) => done(await acceptMemory(context.db, context.ownerId, input.id)));

const revert = owner.input(z.object({ id: ID })).handler(async ({ input, context }) => done(await revertMemory(context.db, context.ownerId, input.id)));

const restore = owner.input(z.object({ id: ID })).handler(async ({ input, context }) => done(await restoreMemory(context.db, context.ownerId, input.id)));

export const memoriesRouter = { list, write, remove, accept, revert, restore };
