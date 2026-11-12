import { and, asc, count, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { agents, memories, memoryRevisions, tables } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { meter, tracer } from "../telemetry/index.ts";
import { MAX_MEMORY_ENTRIES, MEMORY_TYPE_LABELS, MEMORY_TYPES, type MemoryAuthor, MemoryEntryInput, type MemoryEntryFields, type MemoryScope } from "./model.ts";

// The one way memory is written (design 6.5): the owner's procedures and the agents' tools both
// go through these functions. Writes to one scope are serialized (a transaction lock per scope),
// so the cap holds and every write keeps its revision. The index is never stored: it is made from
// the entries when read, so two Jobs adding facts never rewrite the same row.

export type MemoryEntry = typeof memories.$inferSelect;
export type MemoryRevision = typeof memoryRevisions.$inferSelect;

/** Why a write was refused, in words a person or an agent can act on; `NOT_FOUND` when its target isn't the owner's. */
export type Refusal = { error: string };
export const NOT_FOUND = "Not found";

const traces = tracer("memory");
const writes = meter("memory").counter("dispand.memory.writes", { description: "Memory writes, by scope, operation and result" });

type Op = "add" | "update" | "remove" | "accept" | "revert" | "restore";

/** A write in a `memory.write` span and counted: its scope, operation and result only, never a path, a name or a body. */
function recorded<T extends { id: string } | Refusal>(scope: MemoryScope["scope"], op: Op, write: (setOp: (op: Op) => void) => Promise<T>): Promise<T> {
  return traces.startActiveSpan("memory.write", async (span) => {
    let result = "error";
    try {
      const done = await write((o) => (op = o));
      result = "error" in done ? (done.error === NOT_FOUND ? "not-found" : "refused") : "ok";
      return done;
    } finally {
      const attributes = { "dispand.memory.scope": scope, "dispand.memory.op": op, "dispand.result": result };
      span.setAttributes(attributes);
      span.end();
      writes.add(1, attributes);
    }
  });
}

function inScope(ownerId: string, where: MemoryScope) {
  return and(
    eq(memories.ownerId, ownerId),
    eq(memories.scope, where.scope),
    where.scope === "table" ? eq(memories.tableId, where.tableId) : where.scope === "agent" ? eq(memories.agentId, where.agentId) : undefined,
  );
}

function scopeOf(row: MemoryEntry): MemoryScope {
  if (row.scope === "table") return { scope: "table", tableId: row.tableId! };
  if (row.scope === "agent") return { scope: "agent", agentId: row.agentId! };
  return { scope: "workspace" };
}

/** Serializes the writes to one scope until the transaction ends. */
async function lockScope(tx: Tx, ownerId: string, where: MemoryScope) {
  const id = where.scope === "table" ? where.tableId : where.scope === "agent" ? where.agentId : "";
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`dispand:memory:${ownerId}:${where.scope}:${id}`}))`);
}

/** Whether the scope's table or agent is the owner's (the workspace's always is). */
export async function scopeExists(db: Db | Tx, ownerId: string, where: MemoryScope): Promise<boolean> {
  if (where.scope === "workspace") return true;
  const [found] =
    where.scope === "table"
      ? await db.select({ id: tables.id }).from(tables).where(and(eq(tables.id, where.tableId), eq(tables.ownerId, ownerId)))
      : await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, where.agentId), eq(agents.ownerId, ownerId)));
  return Boolean(found);
}

/** Refuses a write that would make one more entry live in a full scope. */
async function full(tx: Tx, ownerId: string, where: MemoryScope): Promise<Refusal | null> {
  const [live] = await tx.select({ n: count() }).from(memories).where(and(inScope(ownerId, where), isNull(memories.removedAt)));
  return live && live.n >= MAX_MEMORY_ENTRIES ? { error: `This memory holds ${MAX_MEMORY_ENTRIES} entries already: remove one first.` } : null;
}

/**
 * Makes `fields` the entry's next revision (its first when `row` is null), live or removed. A
 * person's revision needs no acceptance and an agent's isn't accepted yet: either way the
 * acceptance is cleared.
 */
async function commit(tx: Tx, ownerId: string, where: MemoryScope, row: MemoryEntry | null, fields: MemoryEntryFields, author: MemoryAuthor, removed: boolean) {
  const now = new Date();
  const state = { ...fields, author, acceptedAt: null, removedAt: removed ? now : null, updatedAt: now };
  let id: string;
  let revision: number;
  if (row) {
    ({ id } = row);
    revision = row.revision + 1;
    await tx.update(memories).set({ ...state, revision }).where(eq(memories.id, id));
  } else {
    id = newId("mem");
    revision = 1;
    await tx.insert(memories).values({
      id,
      ownerId,
      scope: where.scope,
      tableId: where.scope === "table" ? where.tableId : null,
      agentId: where.scope === "agent" ? where.agentId : null,
      revision,
      ...state,
    });
  }
  await tx.insert(memoryRevisions).values({ id: newId("memrev"), memoryId: id, revision, ...fields, removed, author, createdAt: now });
  return { id };
}

function fieldsOf(r: Pick<MemoryEntry, "path" | "name" | "description" | "type" | "body">): MemoryEntryFields {
  return { path: r.path, name: r.name, description: r.description, type: r.type, body: r.body };
}

/**
 * Writes an entry at its path: `add` refuses a path that has a live entry, `update` one that
 * hasn't, `upsert` does either. A removed entry's path is free: writing there brings it back.
 * Every refusal is in words, the same for every writer.
 */
export function writeMemory(db: Db | Tx, ownerId: string, where: MemoryScope, entry: unknown, author: MemoryAuthor, mode: "add" | "update" | "upsert"): Promise<{ id: string } | Refusal> {
  return recorded(where.scope, mode === "update" ? "update" : "add", async (setOp) => {
    const parsed = MemoryEntryInput.safeParse(entry);
    if (!parsed.success) return { error: parsed.error.issues[0]!.message };
    const fields = parsed.data;
    return db.transaction(async (tx) => {
      await lockScope(tx, ownerId, where);
      if (!(await scopeExists(tx, ownerId, where))) return { error: NOT_FOUND };
      const [row] = await tx.select().from(memories).where(and(inScope(ownerId, where), eq(memories.path, fields.path)));
      const live = row && !row.removedAt;
      setOp(live ? "update" : "add");
      if (live && mode === "add") return { error: `An entry ${fields.path} exists already.` };
      if (!live && mode === "update") return { error: `There is no entry ${fields.path}.` };
      if (!live) {
        const refused = await full(tx, ownerId, where);
        if (refused) return refused;
      }
      return commit(tx, ownerId, where, row ?? null, fields, author, false);
    });
  });
}

/** Removes the live entry at `path`, as a revision of its own (it can be restored); false when there is none. */
export async function removeMemory(db: Db | Tx, ownerId: string, where: MemoryScope, path: string, author: MemoryAuthor): Promise<boolean> {
  const [row] = await db.select({ id: memories.id }).from(memories).where(and(inScope(ownerId, where), eq(memories.path, path), isNull(memories.removedAt)));
  if (!row) return false;
  return !("error" in (await removeMemoryById(db, ownerId, row.id, author)));
}

/** The owner's entry `id` and its scope, under the scope's lock; null when it isn't theirs. */
async function lockedEntry(tx: Tx, ownerId: string, id: string): Promise<MemoryEntry | null> {
  const [found] = await tx.select().from(memories).where(and(eq(memories.id, id), eq(memories.ownerId, ownerId)));
  if (!found) return null;
  await lockScope(tx, ownerId, scopeOf(found));
  // Read again under the lock: another write may have landed since.
  const [row] = await tx.select().from(memories).where(eq(memories.id, id));
  return row ?? null;
}

/** An entry `id`'s write under its scope's lock, recorded with that scope (`workspace` when the entry isn't the owner's). */
async function onEntry(db: Db | Tx, ownerId: string, id: string, op: Op, write: (tx: Tx, row: MemoryEntry) => Promise<{ id: string } | Refusal>) {
  const [found] = await db.select({ scope: memories.scope }).from(memories).where(and(eq(memories.id, id), eq(memories.ownerId, ownerId)));
  return recorded(found?.scope ?? "workspace", op, () =>
    db.transaction(async (tx) => {
      const row = await lockedEntry(tx, ownerId, id);
      return row ? write(tx, row) : { error: NOT_FOUND };
    }),
  );
}

export function removeMemoryById(db: Db | Tx, ownerId: string, id: string, author: MemoryAuthor) {
  return onEntry(db, ownerId, id, "remove", async (tx, row) => {
    if (row.removedAt) return { error: "This entry is removed already." };
    return commit(tx, ownerId, scopeOf(row), row, fieldsOf(row), author, true);
  });
}

/** A person accepts an agent's entry as it is now, so it may instruct agents that configure the workspace. */
export function acceptMemory(db: Db | Tx, ownerId: string, id: string) {
  return onEntry(db, ownerId, id, "accept", async (tx, row) => {
    if (row.removedAt || row.author.type !== "agent") return { error: "Only an agent's entry, not removed, can be accepted." };
    await tx.update(memories).set({ acceptedAt: new Date() }).where(eq(memories.id, row.id));
    return { id: row.id };
  });
}

/**
 * Brings back the entry's previous revision, its author included, as a new revision; reverting
 * a first revision removes the entry (which can be restored). Not an acceptance: an agent's
 * revision brought back waits for one again.
 */
export function revertMemory(db: Db | Tx, ownerId: string, id: string) {
  return onEntry(db, ownerId, id, "revert", async (tx, row) => {
    const where = scopeOf(row);
    if (row.revision === 1) {
      const [first] = await tx.select().from(memoryRevisions).where(and(eq(memoryRevisions.memoryId, row.id), eq(memoryRevisions.revision, 1)));
      return commit(tx, ownerId, where, row, fieldsOf(row), first!.author, true);
    }
    const [previous] = await tx.select().from(memoryRevisions).where(and(eq(memoryRevisions.memoryId, row.id), eq(memoryRevisions.revision, row.revision - 1)));
    if (!previous!.removed && row.removedAt) {
      const refused = await full(tx, ownerId, where);
      if (refused) return refused;
    }
    return commit(tx, ownerId, where, row, fieldsOf(previous!), previous!.author, previous!.removed);
  });
}

/** Brings a removed entry back as it last was, its author included. */
export function restoreMemory(db: Db | Tx, ownerId: string, id: string) {
  return onEntry(db, ownerId, id, "restore", async (tx, row) => {
    if (!row.removedAt) return { error: "This entry isn't removed." };
    const where = scopeOf(row);
    const refused = await full(tx, ownerId, where);
    if (refused) return refused;
    const [last] = await tx
      .select()
      .from(memoryRevisions)
      .where(and(eq(memoryRevisions.memoryId, row.id), eq(memoryRevisions.removed, false)))
      .orderBy(desc(memoryRevisions.revision))
      .limit(1);
    // Every entry's first revision is live, so there is one.
    return commit(tx, ownerId, where, row, fieldsOf(last!), last!.author, false);
  });
}

/** A scope's live entries, by path. */
export function listMemory(db: Db | Tx, ownerId: string, where: MemoryScope): Promise<MemoryEntry[]> {
  return db
    .select()
    .from(memories)
    .where(and(inScope(ownerId, where), isNull(memories.removedAt)))
    .orderBy(asc(memories.path));
}

/** An entry's revisions, the latest first. */
export function memoryRevisionsOf(db: Db | Tx, memoryId: string): Promise<MemoryRevision[]> {
  return db.select().from(memoryRevisions).where(eq(memoryRevisions.memoryId, memoryId)).orderBy(desc(memoryRevisions.revision));
}

/** The index of a scope's entries: one line each (`- [name](path): description`), grouped by type, by path in each group. */
export function memoryIndex(entries: Pick<MemoryEntry, "path" | "name" | "description" | "type">[]): string {
  return MEMORY_TYPES.flatMap((type) => {
    const group = entries.filter((e) => e.type === type).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return group.length === 0 ? [] : [[`${MEMORY_TYPE_LABELS[type]}:`, ...group.map((e) => `- [${e.name}](${e.path}): ${e.description}`)].join("\n")];
  }).join("\n\n");
}
