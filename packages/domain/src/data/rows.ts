import { ORPCError } from "@orpc/server";
import { and, asc, count, eq, inArray, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Tx } from "../db/client.ts";
import { fields as fieldsTable, rows as rowsTable, tables as tablesTable } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { authed, base } from "../rpc/context.ts";
import { type Cell, CELL_LIMITS, cellSchema, cellText, type FieldSchema } from "./fields.ts";
import { attachmentsById, lockAttachments } from "./files.ts";
import { type Filter, filterValue, queryProblem, RowQuery, type Sort } from "./query.ts";
import { MAX_FIELDS } from "./tables.ts";

// Rows of a table. Every write goes through `writeRow`, which takes the table's row `FOR SHARE`:
// a schema change (which locks it `FOR UPDATE`) finishes first, and the write is checked
// against the fields as they are after it.

const owner = base.use(authed);

export const MAX_PAGE = 500;

export type RowView = { id: string; tableId: string; values: Record<string, Cell>; createdAt: Date; updatedAt: Date };

function rowView(r: typeof rowsTable.$inferSelect): RowView {
  const { id, tableId, values, createdAt, updatedAt } = r;
  return { id, tableId, values, createdAt, updatedAt };
}

const schemaOf = (f: typeof fieldsTable.$inferSelect): FieldSchema => ({ id: f.id, name: f.name, type: f.type, choices: f.choices, referencesTableId: f.referencesTableId });

const cell = (id: string) => sql`${rowsTable.values} -> ${id}::text`;
const cellAsText = (id: string) => sql`${rowsTable.values} ->> ${id}::text`;
/** The cell as a number; null when it holds anything else. */
const cellAsNumber = (id: string) => sql`case when jsonb_typeof(${cell(id)}) = 'number' then (${cellAsText(id)})::double precision end`;
const isChecked = (id: string) => sql`coalesce(${cell(id)} = 'true'::jsonb, false)`;
/** Empty: missing, null, "" or []. */
const isEmpty = (id: string) => sql`coalesce(${cell(id)}, 'null'::jsonb) in ('null'::jsonb, '""'::jsonb, '[]'::jsonb)`;

/** One condition per filter, ANDed. The query must have passed `queryProblem`. */
export function whereOf(fields: FieldSchema[], filters: Filter[]): SQL {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const conditions = filters.map((filter): SQL => {
    const field = byId.get(filter.fieldId)!;
    const id = field.id;
    if (filter.op === "empty") return isEmpty(id);
    if (filter.op === "not-empty") return sql`not ${isEmpty(id)}`;
    if (filter.op === "checked") return isChecked(id);
    if (filter.op === "unchecked") return sql`not ${isChecked(id)}`;
    const parsed = filterValue(field, filter);
    const value = parsed.ok ? parsed.value : null;
    if (field.type === "number") {
      const n = cellAsNumber(id);
      const v = sql`${Number(value)}::double precision`;
      const ops = { "=": sql`${n} = ${v}`, "!=": sql`${n} is distinct from ${v}`, "<": sql`${n} < ${v}`, "<=": sql`${n} <= ${v}`, ">": sql`${n} > ${v}`, ">=": sql`${n} >= ${v}` };
      return ops[filter.op as keyof typeof ops];
    }
    const v = String(value);
    if (field.type === "date" || field.type === "single-select" || field.type === "reference") {
      // Dates are ISO text, so they compare as text; a single select compares choice ids, a reference row ids.
      const t = cellAsText(id);
      const ops = { is: sql`${t} = ${v}`, "is-not": sql`${t} is distinct from ${v}`, before: sql`${t} < ${v}`, after: sql`${t} > ${v}` };
      return ops[filter.op as keyof typeof ops];
    }
    // Text: case-insensitive; `strpos`, not LIKE, so `%` and `_` are literal.
    const t = sql`lower(coalesce(${cellAsText(id)}, ''))`;
    const ops = {
      contains: sql`strpos(${t}, lower(${v})) > 0`,
      "not-contains": sql`strpos(${t}, lower(${v})) = 0`,
      is: sql`${t} = lower(${v})`,
      "is-not": sql`${t} <> lower(${v})`,
    };
    return ops[filter.op as keyof typeof ops];
  });
  return conditions.length > 0 ? sql.join(conditions, sql` and `) : sql`true`;
}

/** The sort's keys, empty cells last, then creation order. The query must have passed `queryProblem`. */
export function orderOf(fields: FieldSchema[], sort: Sort[]): SQL[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const keys = sort.map((s): SQL => {
    const field = byId.get(s.fieldId)!;
    const id = field.id;
    const key =
      field.type === "number"
        ? cellAsNumber(id)
        : field.type === "checkbox"
          ? isChecked(id)
          : field.type === "single-select"
            ? sql`array_position(array[${sql.join(field.choices.map((c) => sql`${c.id}::text`), sql`, `)}]::text[], ${cellAsText(id)})`
            : field.type === "date"
              ? cellAsText(id)
              : sql`lower(nullif(${cellAsText(id)}, ''))`;
    return s.dir === "asc" ? sql`${key} asc nulls last` : sql`${key} desc nulls last`;
  });
  return [...keys, asc(rowsTable.createdAt), asc(rowsTable.id)];
}

type Written = { row: RowView } | { problem: string; notFound?: true };

/**
 * The one way a row is written (procedures, and the engine's Data steps). Waits for any schema
 * change of the table, checks every value against its field, then inserts the row or merges the
 * values into it (`||`, so concurrent edits of different cells both land).
 */
export async function writeRow(tx: Tx, input: { ownerId: string; tableId: string; rowId?: string; values: Record<string, Cell> }): Promise<Written> {
  const [table] = await tx
    .select({ id: tablesTable.id })
    .from(tablesTable)
    .where(and(eq(tablesTable.id, input.tableId), eq(tablesTable.ownerId, input.ownerId)))
    .for("share");
  if (!table) return { problem: "table not found", notFound: true };
  const fields = new Map((await tx.select().from(fieldsTable).where(eq(fieldsTable.tableId, table.id))).map((f) => [f.id, schemaOf(f)]));
  for (const [id, value] of Object.entries(input.values)) {
    const field = fields.get(id);
    if (!field) return { problem: `This table has no field “${id}”` };
    const checked = cellSchema(field).safeParse(value);
    if (!checked.success) return { problem: `“${field.name}”: ${checked.error.issues[0]?.message ?? "not a valid value"}` };
  }
  // Files: only this table's own uploads, locked so the sweep keeps them until this commits.
  const files = Object.entries(input.values).filter(([id, value]) => fields.get(id)!.type === "attachment" && Array.isArray(value));
  const known = await lockAttachments(tx, input.ownerId, table.id, files.flatMap(([, ids]) => ids as string[]));
  for (const [id, ids] of files) {
    if ((ids as string[]).some((a) => !known.has(a))) return { problem: `“${fields.get(id)!.name}”: no such file` };
  }
  // References: each names a row of its field's table, the owner's.
  for (const [id, value] of Object.entries(input.values)) {
    const field = fields.get(id)!;
    if (field.type !== "reference" || typeof value !== "string") continue;
    const [target] = await tx
      .select({ id: rowsTable.id })
      .from(rowsTable)
      .where(and(eq(rowsTable.id, value), eq(rowsTable.tableId, field.referencesTableId ?? ""), eq(rowsTable.ownerId, input.ownerId)))
      .for("share");
    if (!target) return { problem: `“${field.name}”: no such row` };
  }
  const values = JSON.stringify(input.values);
  if (!input.rowId) {
    const [row] = await tx.insert(rowsTable).values({ id: newId("row"), ownerId: input.ownerId, tableId: table.id, values: input.values }).returning();
    return { row: rowView(row!) };
  }
  const [row] = await tx
    .update(rowsTable)
    .set({ values: sql`${rowsTable.values} || ${values}::jsonb`, updatedAt: sql`now()` })
    .where(and(eq(rowsTable.id, input.rowId), eq(rowsTable.tableId, table.id)))
    .returning();
  if (!row) return { problem: "row not found", notFound: true };
  return { row: rowView(row) };
}

function written(result: Written): RowView {
  if ("row" in result) return result.row;
  throw new ORPCError(result.notFound ? "NOT_FOUND" : "BAD_REQUEST", { message: result.problem });
}

async function requireTable(db: Db, ownerId: string, id: string) {
  const [table] = await db
    .select({ id: tablesTable.id })
    .from(tablesTable)
    .where(and(eq(tablesTable.id, id), eq(tablesTable.ownerId, ownerId)));
  if (!table) throw new ORPCError("NOT_FOUND");
  return table;
}

async function requireRow(db: Db, ownerId: string, id: string) {
  const [row] = await db
    .select()
    .from(rowsTable)
    .where(and(eq(rowsTable.id, id), eq(rowsTable.ownerId, ownerId)));
  if (!row) throw new ORPCError("NOT_FOUND");
  return row;
}

/** The files the attachment cells of these rows show. */
function attachmentsOf(db: Db, ownerId: string, fields: FieldSchema[], page: { values: Record<string, Cell> }[]) {
  const ids = fields.filter((f) => f.type === "attachment").flatMap((f) => page.flatMap((r) => r.values[f.id] ?? []));
  return attachmentsById(db, ownerId, ids.filter((id): id is string => typeof id === "string"));
}

/** A row a reference cell names: its first field as text, and its table (a Job sees only its own tables' labels). */
export type ReferenceLabel = { label: string; tableId: string };

/** A label for each row the reference cells of these rows name: its first field, as text. */
export async function referencesOf(db: Db | Tx, ownerId: string, fields: FieldSchema[], page: { values: Record<string, Cell> }[]): Promise<Record<string, ReferenceLabel>> {
  const ids = [...new Set(fields.filter((f) => f.type === "reference").flatMap((f) => page.map((r) => r.values[f.id])).filter((v): v is string => typeof v === "string"))];
  if (ids.length === 0) return {};
  const named = await db.select({ id: rowsTable.id, tableId: rowsTable.tableId, values: rowsTable.values }).from(rowsTable).where(and(inArray(rowsTable.id, ids), eq(rowsTable.ownerId, ownerId)));
  const tableIds = [...new Set(named.map((r) => r.tableId))];
  const firsts = tableIds.length
    ? await db.select().from(fieldsTable).where(and(inArray(fieldsTable.tableId, tableIds), eq(fieldsTable.position, 0)))
    : [];
  const labels: Record<string, ReferenceLabel> = {};
  for (const r of named) {
    const first = firsts.find((f) => f.tableId === r.tableId);
    const value = first ? r.values[first.id] : null;
    labels[r.id] = { label: first && value !== null && value !== undefined ? cellText(schemaOf(first), value) : "", tableId: r.tableId };
  }
  return labels;
}

const AnyCell = z.union([
  z.string().max(CELL_LIMITS["long-text"]),
  z.number(),
  z.boolean(),
  z.array(z.string().max(200)).max(CELL_LIMITS.attachments),
  z.null(),
]);
const Values = z
  .record(z.string().max(64), AnyCell)
  .refine((v) => Object.keys(v).length <= MAX_FIELDS, `At most ${MAX_FIELDS} values`);

const list = owner
  .input(
    z.object({
      tableId: z.string(),
      query: RowQuery.optional(),
      offset: z.number().int().min(0).max(100_000).default(0),
      limit: z.number().int().min(1).max(MAX_PAGE).default(100),
    }),
  )
  .handler(async ({ input, context }) => {
    const table = await requireTable(context.db, context.ownerId, input.tableId);
    const fields = (await context.db.select().from(fieldsTable).where(eq(fieldsTable.tableId, table.id))).map(schemaOf);
    const query = input.query ?? { filters: [], sort: [] };
    const problem = queryProblem(query, fields);
    if (problem) throw new ORPCError("BAD_REQUEST", { message: problem });
    const where = and(eq(rowsTable.tableId, table.id), whereOf(fields, query.filters));
    const [page, [total]] = await Promise.all([
      context.db
        .select()
        .from(rowsTable)
        .where(where)
        .orderBy(...orderOf(fields, query.sort))
        .limit(input.limit)
        .offset(input.offset),
      context.db.select({ n: count() }).from(rowsTable).where(where),
    ]);
    return {
      rows: page.map(rowView),
      total: total!.n,
      attachments: await attachmentsOf(context.db, context.ownerId, fields, page),
      references: await referencesOf(context.db, context.ownerId, fields, page),
    };
  });

const get = owner.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
  const row = await requireRow(context.db, context.ownerId, input.id);
  const fields = (await context.db.select().from(fieldsTable).where(eq(fieldsTable.tableId, row.tableId))).map(schemaOf);
  return { ...rowView(row), attachments: await attachmentsOf(context.db, context.ownerId, fields, [row]), references: await referencesOf(context.db, context.ownerId, fields, [row]) };
});

const create = owner.input(z.object({ tableId: z.string(), values: Values.optional() })).handler(async ({ input, context }) => {
  const row = written(
    await context.db.transaction((tx) => writeRow(tx, { ownerId: context.ownerId, tableId: input.tableId, values: input.values ?? {} })),
  );
  context.dataEvents.publish({ type: "rows", tableId: row.tableId, rowIds: [row.id] });
  return row;
});

/** Sets the given cells; the others stay as they are. */
const update = owner.input(z.object({ id: z.string(), values: Values })).handler(async ({ input, context }) => {
  const current = await requireRow(context.db, context.ownerId, input.id);
  const row = written(
    await context.db.transaction((tx) =>
      writeRow(tx, { ownerId: context.ownerId, tableId: current.tableId, rowId: current.id, values: input.values }),
    ),
  );
  context.dataEvents.publish({ type: "rows", tableId: row.tableId, rowIds: [row.id] });
  return row;
});

/**
 * Adds and removes files of one files cell, applied to the cell as stored, in one transaction that
 * holds the row: two changes made at once (two tabs) both land, and none drops the other's files.
 */
const editFiles = owner
  .input(
    z.object({
      id: z.string(),
      fieldId: z.string().max(64),
      add: z.array(z.string().max(200)).max(CELL_LIMITS.attachments),
      remove: z.array(z.string().max(200)).max(CELL_LIMITS.attachments),
    }),
  )
  .handler(async ({ input, context }) => {
    const current = await requireRow(context.db, context.ownerId, input.id);
    const row = written(
      await context.db.transaction(async (tx): Promise<Written> => {
        // The table first, then the row: the order a schema change takes them in.
        await tx.select({ id: tablesTable.id }).from(tablesTable).where(eq(tablesTable.id, current.tableId)).for("share");
        const [field] = await tx
          .select()
          .from(fieldsTable)
          .where(and(eq(fieldsTable.id, input.fieldId), eq(fieldsTable.tableId, current.tableId)));
        if (field?.type !== "attachment") return { problem: "This field doesn't hold files" };
        const [locked] = await tx.select({ values: rowsTable.values }).from(rowsTable).where(eq(rowsTable.id, current.id)).for("update");
        if (!locked) return { problem: "row not found", notFound: true };
        const stored = locked.values[field.id];
        const gone = new Set(input.remove);
        const next = [...new Set([...(Array.isArray(stored) ? stored : []).filter((id) => !gone.has(id)), ...input.add])];
        return writeRow(tx, { ownerId: context.ownerId, tableId: current.tableId, rowId: current.id, values: { [field.id]: next.length > 0 ? next : null } });
      }),
    );
    context.dataEvents.publish({ type: "rows", tableId: row.tableId, rowIds: [row.id] });
    return row;
  });

/**
 * Empties the reference cells that name rows of `tableId` just deleted, through `writeRow` (so
 * they are writes like any other). Returns the rows changed, by table.
 */
export async function clearReferences(tx: Tx, ownerId: string, tableId: string, deletedIds: string[]): Promise<Map<string, string[]>> {
  const changed = new Map<string, string[]>();
  if (deletedIds.length === 0) return changed;
  const referring = await tx.select().from(fieldsTable).where(and(eq(fieldsTable.referencesTableId, tableId), eq(fieldsTable.ownerId, ownerId)));
  for (const field of referring) {
    const hits = await tx
      .select({ id: rowsTable.id })
      .from(rowsTable)
      .where(and(eq(rowsTable.tableId, field.tableId), inArray(cellAsText(field.id), deletedIds)))
      // Locked, and the condition checked again on the row as it is then: a cell repointed meanwhile is kept.
      .for("update");
    for (const hit of hits) {
      const result = await writeRow(tx, { ownerId, tableId: field.tableId, rowId: hit.id, values: { [field.id]: null } });
      if ("problem" in result) throw new ORPCError("CONFLICT", { message: result.problem });
      changed.set(field.tableId, [...(changed.get(field.tableId) ?? []), hit.id]);
    }
  }
  return changed;
}

/** Deletes rows of one of the owner's tables: an id of another owner or table deletes nothing. */
const remove = owner.input(z.object({ ids: z.array(z.string()).min(1).max(MAX_PAGE) })).handler(async ({ input, context }) => {
  const ids = [...new Set(input.ids)];
  const found = await context.db
    .select({ id: rowsTable.id, tableId: rowsTable.tableId })
    .from(rowsTable)
    .where(and(inArray(rowsTable.id, ids), eq(rowsTable.ownerId, context.ownerId)));
  const tableId = found[0]?.tableId;
  if (found.length !== ids.length || found.some((r) => r.tableId !== tableId)) throw new ORPCError("NOT_FOUND");
  const { deleted, cleared } = await context.db.transaction(async (tx) => {
    const deleted = await tx
      .delete(rowsTable)
      .where(and(inArray(rowsTable.id, ids), eq(rowsTable.tableId, tableId!)))
      .returning({ id: rowsTable.id });
    return { deleted, cleared: await clearReferences(tx, context.ownerId, tableId!, deleted.map((r) => r.id)) };
  });
  if (deleted.length > 0) context.dataEvents.publish({ type: "rows", tableId: tableId!, rowIds: deleted.map((r) => r.id) });
  for (const [otherTable, rowIds] of cleared) context.dataEvents.publish({ type: "rows", tableId: otherTable, rowIds });
});

/** Every change of these tables (the owner's), as it is published. */
const stream = owner.input(z.object({ tableIds: z.array(z.string()).min(1).max(20) })).handler(async function* ({ input, context, signal }) {
  const ids = [...new Set(input.tableIds)];
  // Subscribed before anything waits, so no change made once the stream is read is missed;
  // nothing is yielded unless every table is the owner's.
  const events = context.dataEvents.subscribe(ids, signal);
  try {
    const [mine] = await context.db
      .select({ n: count() })
      .from(tablesTable)
      .where(and(inArray(tablesTable.id, ids), eq(tablesTable.ownerId, context.ownerId)));
    if (mine!.n !== ids.length) throw new ORPCError("NOT_FOUND");
    for await (const event of events) yield event;
  } finally {
    await events.return?.();
  }
});

export const rows = { list, get, create, update, editFiles, delete: remove, stream };
