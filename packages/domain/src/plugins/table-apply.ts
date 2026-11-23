import { createHash } from "node:crypto";
import { call, ORPCError } from "@orpc/server";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { fields as fieldsTable, rows as rowsTable, tables as tablesTable } from "../db/schema.ts";
import { fields, tables, workflowsUsingField } from "../data/tables.ts";
import { reasonOf, say, type Text } from "../messages/index.ts";
import { canonical } from "../platform/approvals.ts";
import { recordCreated } from "../platform/proposals.ts";
import type { InitialContext } from "../rpc/context.ts";
import type { PrimitiveDefinition } from "./definitions.ts";
import { type ActualTable, type TableChange, tableChanges } from "./table-merge.ts";

// How an update's table changes are planned against a table as it is now, and applied through
// the field and table operations a person uses: shared by the update, the plugin row's Apply and
// Stem's table decisions (`resolve.ts`).

/** `values`: for each change that takes values away, a digest of that field's values in every row now, which the screen's token covers. */
export type TablePlan = { tableId: string; name: string; changes: TableChange[]; kept: PrimitiveDefinition; next: PrimitiveDefinition; fields: (ActualTable["fields"][number] & { referencesTableId: string | null })[]; values: Record<string, string> };
/** The plugin's tables, and whether a definition's table name finds one (the plugin's, or one of the owner's own). */
export async function tablesOf(db: Db | Tx, ownerId: string, row: { id: string }) {
  const rowsOf = await db.select().from(tablesTable).where(and(eq(tablesTable.pluginId, row.id), eq(tablesTable.ownerId, ownerId)));
  const local = await db.select({ id: tablesTable.id, name: tablesTable.name }).from(tablesTable).where(and(eq(tablesTable.ownerId, ownerId), sql`${tablesTable.pluginId} is null`));
  const lower = (s: string | null) => (s ?? "").toLowerCase();
  const tableExists = (name: string) => rowsOf.some((t) => lower(t.pluginComponent) === lower(name)) || local.some((t) => lower(t.name) === lower(name));
  /** A table's name as a definition says it: the plugin's component name, else its own. */
  const nameOf = (id: string) => rowsOf.find((t) => t.id === id)?.pluginComponent ?? local.find((t) => t.id === id)?.name ?? null;
  return { rowsOf, tableExists, nameOf };
}

/** One table's changes from `kept` (given the table's fields as they are now) to `next`, with what each would stop or take away. */
export async function tablePlan(db: Db | Tx, ownerId: string, t: typeof tablesTable.$inferSelect, keptOf: (fields: TablePlan["fields"], parentField: string | null) => PrimitiveDefinition, next: PrimitiveDefinition, tableExists: (name: string) => boolean): Promise<TablePlan> {
  const lower = (s: string | null) => (s ?? "").toLowerCase();
  const fields = (await db.select().from(fieldsTable).where(eq(fieldsTable.tableId, t.id)).orderBy(asc(fieldsTable.position))).map((f) => ({ id: f.id, name: f.name, type: f.type, choices: f.choices, pluginField: f.pluginField, referencesTableId: f.referencesTableId }));
  const parentField = fields.find((f) => f.id === t.parentFieldId)?.name ?? null;
  const kept = keptOf(fields, parentField);
  const [counted] = await db.select({ n: sql<number>`count(*)::int` }).from(rowsTable).where(eq(rowsTable.tableId, t.id));
  const changes = tableChanges(kept, next, { primitive: t.primitive, parentField, parentRequired: t.parentRequired, fields }, counted?.n ?? 0, tableExists);
  // A field a workflow's data step names: removing it, or changing its type, stops that workflow, said beside the change.
  for (const c of changes.filter((c) => (c.kind === "remove" || c.kind === "retype") && c.field)) {
    const field = fields.find((f) => lower(f.pluginField) === lower(c.field!));
    const stops = field ? await workflowsUsingField(db, t.workspaceId, t.id, field.id) : [];
    if (stops.length) c.stops = stops;
  }
  // What a change that takes values away would take, as it is now: a value written after the screen was read changes the token, and the update is shown again.
  const losing = changes.filter((c) => c.loses !== undefined && c.field);
  const rows = losing.length ? await db.select({ id: rowsTable.id, values: rowsTable.values }).from(rowsTable).where(eq(rowsTable.tableId, t.id)).orderBy(asc(rowsTable.id)) : [];
  const values: Record<string, string> = {};
  for (const c of losing) {
    const field = fields.find((f) => lower(f.pluginField) === lower(c.field!));
    if (field) values[c.key] = createHash("sha256").update(canonical(rows.map((r) => [r.id, r.values[field.id] ?? null]))).digest("hex");
  }
  return { tableId: t.id, name: t.name, changes, kept, next, fields, values };
}

/**
 * Applies the changes of a plugin's table its owner ticked, each through the field or table
 * operation a person would use, and gives the definition an update keeps as the one the table
 * was merged with: the new one, but for what waits for a table that isn't there yet or failed,
 * offered again by the next update. `held`: changes waiting for the owner's Approval, which stay
 * as they were in that definition too. Each failure names its change (`key`).
 */
export async function applyTable(context: InitialContext & { ownerId: string }, row: { id: string }, plan: TablePlan, ticked: string[], failed: { name: string; reason: Text; key?: string }[], held: string[] = []): Promise<PrimitiveDefinition> {
  const lower = (s: string | null) => (s ?? "").toLowerCase();
  // The keys of the changes that failed: their part of the definition stays as it was, so the next update offers them again.
  const refused = new Set<string>();
  const run = async (key: string, path: string[], procedure: unknown, input: object, element?: { pluginId: string; component: string }): Promise<unknown> => {
    try {
      return await call(procedure as never, input as never, { context: { ...context, ...(element ? { pluginElement: element } : {}) } as never, path });
    } catch (err) {
      if (!(err instanceof ORPCError)) throw err;
      refused.add(key);
      failed.push({ name: plan.name, reason: reasonOf(err), key });
      return undefined;
    }
  };
  const fieldOf = (name: string) => plan.fields.find((f) => lower(f.pluginField) === lower(name));
  const [tablesNow] = [await context.db.select({ id: tablesTable.id, name: tablesTable.name, component: tablesTable.pluginComponent, pluginId: tablesTable.pluginId }).from(tablesTable).where(eq(tablesTable.ownerId, context.ownerId))];
  const tableNamed = (name: string) => tablesNow.find((t) => t.pluginId === row.id && lower(t.component) === lower(name))?.id ?? tablesNow.find((t) => t.pluginId === null && lower(t.name) === lower(name))?.id;
  const isTicked = (key: string) => ticked.includes(key);
  for (const change of plan.changes.filter((c) => isTicked(c.key) && c.kind !== "primitive" && c.kind !== "parent")) {
    const def = change.field ? plan.next.fields.find((f) => lower(f.name) === lower(change.field!)) : undefined;
    const field = change.field ? fieldOf(change.field) : undefined;
    if (change.kind === "add" && def) {
      const made = await run(change.key, ["fields", "create"], fields.create, { tableId: plan.tableId, name: def.name, type: def.type, ...(def.choices ? { choices: def.choices } : {}), ...(def.references ? { referencesTableId: tableNamed(def.references) } : {}) }, { pluginId: row.id, component: def.name });
      // Recorded as a setup records it: a later setup finds it by id.
      const id = (made as { id?: string } | undefined)?.id;
      if (id) await recordCreated(context.db, row.id, "field", id, `field:${plan.kept.name}.${def.name}`);
    } else if (change.kind === "remove" && field) await run(change.key, ["fields", "delete"], fields.delete, { id: field.id });
    else if (change.kind === "retype" && field && def) await run(change.key, ["fields", "retype"], fields.retype, { id: field.id, type: def.type, dryRun: false });
    else if (change.kind === "choices" && field && def) await run(change.key, ["fields", "update"], fields.update, { id: field.id, choices: def.choices ?? [] });
    else if (change.kind === "move") {
      const now = await context.db.select({ id: fieldsTable.id, pluginField: fieldsTable.pluginField, position: fieldsTable.position }).from(fieldsTable).where(eq(fieldsTable.tableId, plan.tableId)).orderBy(asc(fieldsTable.position));
      // The first field stays first; the plugin's fields in their new order; the owner's own after them, as they were.
      const rank = (f: (typeof now)[number]) => (f.position === 0 ? -1 : f.pluginField === null ? 10_000 + f.position : plan.next.fields.findIndex((d) => lower(d.name) === lower(f.pluginField)));
      await run(change.key, ["fields", "reorder"], fields.reorder, { tableId: plan.tableId, fieldIds: [...now].sort((a, b) => rank(a) - rank(b)).map((f) => f.id) });
    }
  }
  // The primitive flag and the parent, each as ticked: what isn't ticked stays as the table has it.
  if (isTicked("primitive") || isTicked("parent")) {
    const [table] = await context.db.select().from(tablesTable).where(eq(tablesTable.id, plan.tableId));
    const primitive = isTicked("primitive") ? plan.next.primitive : table!.primitive;
    const wanted = isTicked("parent") ? plan.next.parent : undefined;
    const wantedField = wanted ? await context.db.select({ id: fieldsTable.id, referencesTableId: fieldsTable.referencesTableId }).from(fieldsTable).where(and(eq(fieldsTable.tableId, plan.tableId), sql`lower(${fieldsTable.pluginField}) = ${lower(wanted.field)}`)).then((r) => r[0]) : undefined;
    // The plugin's parent field isn't there (its addition declined or refused): the parent stays as it is, offered again.
    const parentTicked = isTicked("parent") && !(wanted && !wantedField?.referencesTableId);
    if (isTicked("parent") && !parentTicked) {
      // Both stay offered: the parent can apply once its field is added.
      refused.add("parent").add(`add:${wanted!.field}`);
      failed.push({ name: plan.name, reason: say("plugins.update.parentMissing", { field: wanted!.field }), key: "parent" });
    }
    const current = table!.parentFieldId ? await context.db.select({ referencesTableId: fieldsTable.referencesTableId }).from(fieldsTable).where(eq(fieldsTable.id, table!.parentFieldId)).then((r) => r[0]) : undefined;
    const parent = parentTicked
      ? wanted && wantedField?.referencesTableId ? { tableId: wantedField.referencesTableId, required: wanted.required } : null
      : current?.referencesTableId ? { tableId: current.referencesTableId, required: table!.parentRequired } : null;
    const key = parentTicked ? "parent" : "primitive";
    if ((parentTicked || isTicked("primitive")) && (await run(key, ["tables", "setPrimitive"], tables.setPrimitive, { id: plan.tableId, primitive, ...(primitive ? { parent } : {}) }))) {
      // The table keeps a parent field that already names that table: when that isn't the one the plugin names, say so.
      const [after] = await context.db.select({ parentFieldId: tablesTable.parentFieldId }).from(tablesTable).where(eq(tablesTable.id, plan.tableId));
      if (parentTicked && wantedField && after?.parentFieldId !== wantedField.id) {
        refused.add("parent");
        failed.push({ name: plan.name, reason: say("plugins.update.parentOther", { field: wanted!.field }), key: "parent" });
      }
    }
  }
  // What waits, or failed, stays as it was in the definition kept, so it is offered again; the rest is the new one, ticked or not.
  return definitionAfter(plan, plan.changes.filter((c) => c.waiting || refused.has(c.key) || held.includes(c.key)));
}

/** The definition a table keeps as merged after its changes: the plugin's new one, but for `again`, kept as they were so the next update offers them. */
export function definitionAfter(plan: TablePlan, again: TableChange[]): PrimitiveDefinition {
  const lower = (s: string | null) => (s ?? "").toLowerCase();
  const keptField = (name: string) => plan.kept.fields.find((f) => lower(f.name) === lower(name));
  const fieldsAfter = plan.next.fields
    .filter((f) => !again.some((c) => c.kind === "add" && lower(c.field ?? "") === lower(f.name)))
    .map((f) => (again.some((c) => (c.kind === "retype" || c.kind === "choices") && lower(c.field ?? "") === lower(f.name)) ? (keptField(f.name) ?? f) : f));
  for (const c of again.filter((c) => c.kind === "remove")) {
    const was = keptField(c.field ?? "");
    if (was) fieldsAfter.push(was);
  }
  return {
    ...plan.next,
    fields: again.some((c) => c.kind === "move") ? [...plan.kept.fields.flatMap((k) => fieldsAfter.filter((a) => lower(a.name) === lower(k.name))), ...fieldsAfter.filter((a) => !keptField(a.name))] : fieldsAfter,
    ...(again.some((c) => c.kind === "primitive") ? { primitive: plan.kept.primitive } : {}),
    ...(again.some((c) => c.kind === "parent") ? { parent: plan.kept.parent } : {}),
  };
}

