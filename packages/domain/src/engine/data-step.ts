import { and, eq } from "drizzle-orm";
import type { Tx } from "../db/client.ts";
import { rows as rowsTable, tables as tablesTable } from "../db/schema.ts";
import { type Cell, cellText, parseCellText } from "../data/fields.ts";
import { FILTER_OPS, type Filter, type FilterOp, filterValue, takesValue } from "../data/query.ts";
import { orderOf, whereOf, writeRow } from "../data/rows.ts";
import { loadTableSchemas } from "../data/tables.ts";
import type { DataStep, Source } from "../workflows/model.ts";

/** The most characters find-rows' `rows` passes on (a prompt holds at most the protocol's `TEXT`). */
export const MAX_ROWS_TEXT = 200_000;

export type DataStepResult = { outputs: Record<string, string>; changed?: { tableId: string; rowIds: string[] } } | { error: string };

/**
 * Runs a data step inside `tx`, against the table as it is now: each source is resolved (a
 * literal as is; an upstream output from `values`, by node id, `""` when missing), parsed with
 * its field's rules, then the row is written through `writeRow` or the rows are found. Nothing
 * is written unless every value fits. Errors are for the owner and name the field and value.
 */
export async function runDataStep(
  tx: Tx,
  input: { ownerId: string; step: DataStep; values: Record<string, Record<string, string>> },
): Promise<DataStepResult> {
  const { ownerId, step, values } = input;
  const resolve = (source: Source) =>
    source.type === "value" ? source.value : Object.hasOwn(values, source.nodeId) && Object.hasOwn(values[source.nodeId]!, source.name) ? values[source.nodeId]![source.name]! : "";
  // Shared with other writes, exclusive with a schema change: the fields can't change under the step.
  const [locked] = await tx
    .select({ id: tablesTable.id })
    .from(tablesTable)
    .where(and(eq(tablesTable.id, step.tableId), eq(tablesTable.ownerId, ownerId)))
    .for("share");
  const [table] = locked ? await loadTableSchemas(tx, ownerId, [locked.id]) : [];
  if (!table) return { error: "The step's table no longer exists" };
  const fields = new Map(table.fields.map((f) => [f.id, f]));

  if (step.action === "find-rows") {
    const filters: Filter[] = [];
    for (const f of step.filters) {
      const field = fields.get(f.fieldId);
      if (!field) return { error: `A field this step filters on no longer exists in ${table.name}` };
      if (!(FILTER_OPS[field.type] as readonly FilterOp[]).includes(f.op)) return { error: `“${field.name}” can't be filtered by “${f.op}”` };
      const filter: Filter = { fieldId: field.id, op: f.op, ...(f.value ? { value: resolve(f.value) } : {}) };
      if (takesValue(f.op)) {
        const parsed = filterValue(field, filter);
        if (!parsed.ok) return { error: `“${field.name}”: ${parsed.reason}` };
        if (parsed.value === null) return { error: `“${field.name}”: a value is needed` };
      }
      filters.push(filter);
    }
    const found = await tx
      .select({ id: rowsTable.id, values: rowsTable.values })
      .from(rowsTable)
      .where(and(eq(rowsTable.tableId, table.id), whereOf(table.fields, filters)))
      .orderBy(...orderOf(table.fields, []))
      .limit(step.limit);
    const text = JSON.stringify(
      found.map((r) => Object.fromEntries([["id", r.id], ...table.fields.map((f) => [f.name, cellText(f, r.values[f.id] ?? null)])])),
    );
    if (text.length > MAX_ROWS_TEXT) {
      return { error: `the rows found are too long to pass on (${text.length} characters, at most ${MAX_ROWS_TEXT}): lower the limit` };
    }
    return { outputs: { count: String(found.length), row_id: found[0]?.id ?? "", rows: text } };
  }

  const cells: Record<string, Cell> = {};
  for (const i of step.inputs) {
    const field = fields.get(i.fieldId);
    if (!field) return { error: `A field this step sets no longer exists in ${table.name}` };
    // Retyped to files since the run started: an empty value would clear the files.
    if (field.type === "attachment") return { error: `“${field.name}” holds files, which a workflow can't set` };
    const parsed = parseCellText(field, resolve(i.source));
    if (!parsed.ok) return { error: `“${field.name}”: ${parsed.reason}` };
    cells[field.id] = parsed.value;
  }
  let rowId: string | undefined;
  if (step.action === "update-row") {
    rowId = resolve(step.rowId).trim();
    if (rowId === "") return { error: `No row of ${table.name} to update: its id is empty` };
  }
  const result = await writeRow(tx, { ownerId, tableId: table.id, ...(rowId ? { rowId } : {}), values: cells });
  if ("problem" in result) {
    if (rowId && result.notFound) return { error: `row “${rowId.length > 100 ? `${Array.from(rowId).slice(0, 100).join("")}…` : rowId}” is not in ${table.name}` };
    return { error: result.problem };
  }
  return { outputs: { row_id: result.row.id }, changed: { tableId: table.id, rowIds: [result.row.id] } };
}
