import { ORPCError } from "@orpc/server";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Tx } from "../db/client.ts";
import { attachments, fields as fieldsTable, rows as rowsTable, runs, tables as tablesTable, workflows, workflowVersions } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { authed, base } from "../rpc/context.ts";
import { tableIdsOf, type TableSchema } from "../workflows/data-steps.ts";
import { StorableText } from "../workflows/model.ts";
import type { DataEvent } from "./events.ts";
import { type Cell, Choice, convertCells, FIELD_TYPES, type FieldSchema, type FieldType, MAX_CHOICES } from "./fields.ts";

// Tables and their fields. Every schema change locks the table's row `FOR UPDATE` first, so
// changes to one table run one at a time, and a row write (which takes it `FOR SHARE`) waits for
// them and then sees the new fields.

const owner = base.use(authed);

export const MAX_FIELDS = 200;

const Name = StorableText(100).trim().min(1);
const Choices = z
  .array(Choice)
  .max(MAX_CHOICES)
  .superRefine((choices, ctx) => {
    const ids = new Set(choices.map((c) => c.id));
    const labels = new Set(choices.map((c) => c.label.toLowerCase()));
    if (ids.size < choices.length || labels.size < choices.length) ctx.addIssue({ code: "custom", message: "Choices must be different" });
  });

type FieldRow = typeof fieldsTable.$inferSelect;

export type FieldView = { id: string; tableId: string; name: string; type: FieldType; choices: Choice[]; position: number };
export type TableView = { id: string; name: string; fields: FieldView[] };

function fieldView(f: FieldRow): FieldView {
  const { id, tableId, name, type, choices, position } = f;
  return { id, tableId, name, type, choices, position };
}

const schemaOf = (f: FieldRow): FieldSchema => ({ id: f.id, name: f.name, type: f.type, choices: f.choices });

/** A unique index refused the name: a CONFLICT naming it. Anything else goes on. */
function nameTaken(what: "table" | "field", name: string) {
  return (err: unknown): never => {
    const e = err as { code?: unknown; cause?: { code?: unknown } };
    if (e.code === "23505" || e.cause?.code === "23505") throw new ORPCError("CONFLICT", { message: `A ${what} is already called “${name}”` });
    throw err;
  };
}

async function lockTable(tx: Tx, ownerId: string, id: string) {
  const [table] = await tx
    .select()
    .from(tablesTable)
    .where(and(eq(tablesTable.id, id), eq(tablesTable.ownerId, ownerId)))
    .for("update");
  if (!table) throw new ORPCError("NOT_FOUND");
  return table;
}

/** Locks the field's table, then reads the field again (it may have gone meanwhile). */
async function lockField(tx: Tx, ownerId: string, id: string) {
  const mine = and(eq(fieldsTable.id, id), eq(fieldsTable.ownerId, ownerId));
  const [found] = await tx.select({ tableId: fieldsTable.tableId }).from(fieldsTable).where(mine);
  if (!found) throw new ORPCError("NOT_FOUND");
  await lockTable(tx, ownerId, found.tableId);
  const [field] = await tx.select().from(fieldsTable).where(mine);
  if (!field) throw new ORPCError("NOT_FOUND");
  return field;
}

const fieldsOf = (tx: Tx | Db, tableId: string) =>
  tx.select().from(fieldsTable).where(eq(fieldsTable.tableId, tableId)).orderBy(asc(fieldsTable.position), asc(fieldsTable.id));

const touch = (tx: Tx, tableId: string) => tx.update(tablesTable).set({ updatedAt: sql`now()` }).where(eq(tablesTable.id, tableId));

async function tableView(tx: Tx | Db, table: { id: string; name: string }): Promise<TableView> {
  return { id: table.id, name: table.name, fields: (await fieldsOf(tx, table.id)).map(fieldView) };
}

/** The owner's tables among `ids`, with their fields in order, as the workflow model sees them. */
export async function loadTableSchemas(db: Db | Tx, ownerId: string, ids: string[]): Promise<TableSchema[]> {
  if (ids.length === 0) return [];
  const found = await db
    .select({ id: tablesTable.id, name: tablesTable.name })
    .from(tablesTable)
    .where(and(eq(tablesTable.ownerId, ownerId), inArray(tablesTable.id, ids)));
  return Promise.all(found.map(async (t) => ({ ...t, fields: (await fieldsOf(db, t.id)).map(schemaOf) })));
}

/** Whether a workflow's current version, or the version of a run still going, has a data step on the table. */
export async function tableInUse(db: Db | Tx, ownerId: string, tableId: string): Promise<boolean> {
  const current = await db
    .select({ def: workflowVersions.def })
    .from(workflows)
    .innerJoin(workflowVersions, and(eq(workflowVersions.workflowId, workflows.id), eq(workflowVersions.version, workflows.currentVersion)))
    .where(eq(workflows.ownerId, ownerId));
  const running = await db
    .select({ def: workflowVersions.def })
    .from(runs)
    .innerJoin(workflowVersions, and(eq(workflowVersions.workflowId, runs.workflowId), eq(workflowVersions.version, runs.version)))
    .where(and(eq(runs.ownerId, ownerId), inArray(runs.status, ["running", "waiting"])));
  return [...current, ...running].some(({ def }) => tableIdsOf(def).includes(tableId));
}

function publish(events: { publish(event: DataEvent): void }, tableId: string, rowIds: string[] = []) {
  if (rowIds.length > 0) events.publish({ type: "rows", tableId, rowIds });
  events.publish({ type: "schema", tableId });
}

const create = owner.input(z.object({ name: Name })).handler(async ({ input, context }) => {
  const table = await context.db
    .transaction(async (tx) => {
      const [table] = await tx.insert(tablesTable).values({ id: newId("tbl"), ownerId: context.ownerId, name: input.name }).returning();
      await tx.insert(fieldsTable).values({ id: newId("fld"), ownerId: context.ownerId, tableId: table!.id, name: "Name", type: "text", position: 0 });
      return tableView(tx, table!);
    })
    .catch(nameTaken("table", input.name));
  publish(context.dataEvents, table.id);
  return table;
});

const list = owner.handler(async ({ context }) => {
  return context.db
    .select({
      id: tablesTable.id,
      name: tablesTable.name,
      rowCount: sql<number>`(select count(*) from "rows" where "rows"."table_id" = "tables"."id")::int`,
      updatedAt: tablesTable.updatedAt,
    })
    .from(tablesTable)
    .where(eq(tablesTable.ownerId, context.ownerId))
    .orderBy(sql`lower(${tablesTable.name})`, asc(tablesTable.id));
});

const get = owner.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
  const [table] = await context.db
    .select()
    .from(tablesTable)
    .where(and(eq(tablesTable.id, input.id), eq(tablesTable.ownerId, context.ownerId)));
  if (!table) throw new ORPCError("NOT_FOUND");
  return tableView(context.db, table);
});

const rename = owner.input(z.object({ id: z.string(), name: Name })).handler(async ({ input, context }) => {
  const table = await context.db
    .transaction(async (tx) => {
      await lockTable(tx, context.ownerId, input.id);
      const [table] = await tx
        .update(tablesTable)
        .set({ name: input.name, updatedAt: sql`now()` })
        .where(eq(tablesTable.id, input.id))
        .returning();
      return tableView(tx, table!);
    })
    .catch(nameTaken("table", input.name));
  publish(context.dataEvents, table.id);
  return table;
});

/** Deletes the table, its fields and rows; refused while a workflow uses it. */
const remove = owner.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
  await context.db.transaction(async (tx) => {
    await lockTable(tx, context.ownerId, input.id);
    if (await tableInUse(tx, context.ownerId, input.id)) throw new ORPCError("CONFLICT", { message: "A workflow uses this table" });
    await tx.delete(tablesTable).where(eq(tablesTable.id, input.id));
  });
  publish(context.dataEvents, input.id);
});

export const tables = { create, list, get, rename, delete: remove };

const createField = owner
  .input(z.object({ tableId: z.string(), name: Name, type: z.enum(FIELD_TYPES), choices: Choices.optional() }))
  .handler(async ({ input, context }) => {
    const choices = input.choices ?? [];
    if (choices.length > 0 && input.type !== "single-select") throw new ORPCError("BAD_REQUEST", { message: "Only a single select has choices" });
    const field = await context.db
      .transaction(async (tx) => {
        await lockTable(tx, context.ownerId, input.tableId);
        const [n] = await tx.select({ n: count() }).from(fieldsTable).where(eq(fieldsTable.tableId, input.tableId));
        if (n!.n >= MAX_FIELDS) throw new ORPCError("BAD_REQUEST", { message: `A table has at most ${MAX_FIELDS} fields` });
        const [field] = await tx
          .insert(fieldsTable)
          .values({ id: newId("fld"), ownerId: context.ownerId, tableId: input.tableId, name: input.name, type: input.type, choices, position: n!.n })
          .returning();
        await touch(tx, input.tableId);
        return field!;
      })
      .catch(nameTaken("field", input.name));
    publish(context.dataEvents, field.tableId);
    return fieldView(field);
  });

/** Renames, or replaces a single select's choices; cells holding a removed choice are cleared. */
const updateField = owner
  .input(z.object({ id: z.string(), name: Name.optional(), choices: Choices.optional() }))
  .handler(async ({ input, context }) => {
    const { field, cleared } = await context.db
      .transaction(async (tx) => {
        const field = await lockField(tx, context.ownerId, input.id);
        let cleared: string[] = [];
        if (input.choices) {
          if (field.type !== "single-select") throw new ORPCError("BAD_REQUEST", { message: "Only a single select has choices" });
          const kept = new Set(input.choices.map((c) => c.id));
          const removed = field.choices.filter((c) => !kept.has(c.id)).map((c) => c.id);
          if (removed.length > 0) {
            // A Job changes fields, not the rows under them: what clears values stays the owner's.
            if (context.job) throw new ORPCError("BAD_REQUEST", { message: "Removing a choice clears the rows that use it: only the owner does that" });
            const changed = await tx
              .update(rowsTable)
              .set({ values: sql`jsonb_set(${rowsTable.values}, array[${field.id}]::text[], 'null'::jsonb)`, updatedAt: sql`now()` })
              .where(and(eq(rowsTable.tableId, field.tableId), inArray(sql`${rowsTable.values} ->> ${field.id}`, removed)))
              .returning({ id: rowsTable.id });
            cleared = changed.map((r) => r.id);
          }
        }
        const [updated] = await tx
          .update(fieldsTable)
          .set({ name: input.name ?? field.name, choices: input.choices ?? field.choices })
          .where(eq(fieldsTable.id, field.id))
          .returning();
        await touch(tx, field.tableId);
        return { field: updated!, cleared };
      })
      .catch(nameTaken("field", input.name ?? ""));
    publish(context.dataEvents, field.tableId, cleared);
    return fieldView(field);
  });

/** Sets the order of the table's fields: `fieldIds` must be exactly its fields. The first is the primary field. */
const reorder = owner
  .input(z.object({ tableId: z.string(), fieldIds: z.array(z.string()).min(1).max(MAX_FIELDS) }))
  .handler(async ({ input, context }) => {
    const view = await context.db.transaction(async (tx) => {
      const table = await lockTable(tx, context.ownerId, input.tableId);
      const current = new Set((await fieldsOf(tx, table.id)).map((f) => f.id));
      const given = new Set(input.fieldIds);
      if (given.size !== input.fieldIds.length || given.size !== current.size || input.fieldIds.some((id) => !current.has(id))) {
        throw new ORPCError("BAD_REQUEST", { message: "List every field of the table once" });
      }
      for (const [position, id] of input.fieldIds.entries()) {
        await tx.update(fieldsTable).set({ position }).where(eq(fieldsTable.id, id));
      }
      await touch(tx, table.id);
      return tableView(tx, table);
    });
    publish(context.dataEvents, view.id);
    return view;
  });

/** The names of a table's files, for a retype from attachment to a text type. */
async function attachmentNames(tx: Tx, tableId: string): Promise<Record<string, string>> {
  const found = await tx.select({ id: attachments.id, name: attachments.name }).from(attachments).where(eq(attachments.tableId, tableId));
  return Object.fromEntries(found.map((a) => [a.id, a.name]));
}

const isEmpty = (cell: Cell) => cell === null || cell === "" || (Array.isArray(cell) && cell.length === 0);

/**
 * Changes a field's type and converts every cell (`convertCells`). With `dryRun`, only counts:
 * `converted` non-empty cells keep a value, `cleared` become empty.
 */
const retype = owner
  .input(z.object({ id: z.string(), type: z.enum(FIELD_TYPES), dryRun: z.boolean() }))
  .handler(async ({ input, context }) => {
    const result = await context.db.transaction(async (tx) => {
      const field = await lockField(tx, context.ownerId, input.id);
      const stored = await tx
        .select({ id: rowsTable.id, values: rowsTable.values })
        .from(rowsTable)
        .where(eq(rowsTable.tableId, field.tableId))
        .orderBy(asc(rowsTable.createdAt), asc(rowsTable.id))
        .for("update");
      const from = schemaOf(field);
      const to: FieldSchema = { ...from, type: input.type, choices: input.type === "single-select" && field.type === "single-select" ? field.choices : [] };
      const cells = stored.map((r) => r.values[field.id] ?? null);
      const converted = convertCells(cells, from, to, () => newId("choice"), from.type === "attachment" ? await attachmentNames(tx, field.tableId) : {});
      const counts = { converted: cells.filter((c) => !isEmpty(c)).length - converted.cleared, cleared: converted.cleared };
      if (input.dryRun) return { ...counts, field, rowIds: [] as string[] };
      const changes = stored
        .map((r, i) => ({ id: r.id, before: r.values[field.id], v: converted.cells[i]! }))
        .filter((c) => c.before !== undefined && JSON.stringify(c.before) !== JSON.stringify(c.v));
      if (changes.length > 0) {
        // One statement for every changed cell; a JSON null in the record set is SQL NULL, hence the coalesce.
        await tx.execute(sql`
          update ${rowsTable} set "values" = jsonb_set(${rowsTable}."values", array[${field.id}]::text[], coalesce(c.v, 'null'::jsonb)), "updated_at" = now()
          from jsonb_to_recordset(${JSON.stringify(changes.map(({ id, v }) => ({ id, v })))}::jsonb) as c(id text, v jsonb)
          where ${rowsTable}."id" = c.id`);
      }
      const [updated] = await tx
        .update(fieldsTable)
        .set({ type: input.type, choices: input.type === "single-select" ? converted.choices : [] })
        .where(eq(fieldsTable.id, field.id))
        .returning();
      await touch(tx, field.tableId);
      return { ...counts, field: updated!, rowIds: changes.map((c) => c.id) };
    });
    if (!input.dryRun) publish(context.dataEvents, result.field.tableId, result.rowIds);
    return { converted: result.converted, cleared: result.cleared, field: fieldView(result.field) };
  });

/** Deletes a field and its cells in every row. A table keeps at least one field. */
const removeField = owner.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
  const tableId = await context.db.transaction(async (tx) => {
    const field = await lockField(tx, context.ownerId, input.id);
    const rest = (await fieldsOf(tx, field.tableId)).filter((f) => f.id !== field.id);
    if (rest.length === 0) throw new ORPCError("BAD_REQUEST", { message: "A table keeps at least one field" });
    await tx.delete(fieldsTable).where(eq(fieldsTable.id, field.id));
    await tx
      .update(rowsTable)
      .set({ values: sql`${rowsTable.values} - ${field.id}::text` })
      .where(and(eq(rowsTable.tableId, field.tableId), sql`(${rowsTable.values} -> ${field.id}::text) is not null`));
    for (const [position, f] of rest.entries()) {
      if (f.position !== position) await tx.update(fieldsTable).set({ position }).where(eq(fieldsTable.id, f.id));
    }
    await touch(tx, field.tableId);
    return field.tableId;
  });
  publish(context.dataEvents, tableId);
});

export const fields = { create: createField, update: updateField, reorder, retype, delete: removeField };
