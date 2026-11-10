import { z } from "zod";
import { StorableText } from "../text.ts";
import { type Cell, type FieldSchema, type FieldType, parseCellText } from "./fields.ts";

// Sort and filter of a table's rows: what each field type can be filtered by, and the checks a
// query passes before it becomes SQL (`rows.ts`). Pure, so the web app builds the same queries.

const TEXT_OPS = ["contains", "not-contains", "is", "is-not", "empty", "not-empty"] as const;

export const FILTER_OPS = {
  text: TEXT_OPS,
  "long-text": TEXT_OPS,
  url: TEXT_OPS,
  number: ["=", "!=", "<", "<=", ">", ">=", "empty", "not-empty"],
  checkbox: ["checked", "unchecked"],
  date: ["is", "before", "after", "empty", "not-empty"],
  "single-select": ["is", "is-not", "empty", "not-empty"],
  attachment: ["empty", "not-empty"],
} as const satisfies Record<FieldType, readonly string[]>;

export type FilterOp = (typeof FILTER_OPS)[FieldType][number];

/** Every op of every type. */
export const FILTER_OP_NAMES = [...new Set(Object.values(FILTER_OPS).flat())] as [FilterOp, ...FilterOp[]];
const NO_VALUE: ReadonlySet<FilterOp> = new Set(["empty", "not-empty", "checked", "unchecked"]);

/** Whether the op compares with a value (`empty`, `checked`... don't). */
export const takesValue = (op: FilterOp) => !NO_VALUE.has(op);

export const Filter = z.object({ fieldId: z.string().max(64), op: z.enum(FILTER_OP_NAMES), value: StorableText(10_000).optional() });
export type Filter = z.infer<typeof Filter>;
export const Sort = z.object({ fieldId: z.string().max(64), dir: z.enum(["asc", "desc"]) });
export type Sort = z.infer<typeof Sort>;
export const RowQuery = z.object({ filters: z.array(Filter).max(20).default([]), sort: z.array(Sort).max(3).default([]) });
export type RowQuery = z.infer<typeof RowQuery>;

/**
 * The filter's value as a cell of its field. `contains` and `not-contains` take any text (a part
 * of a URL isn't a URL); every other op parses the value with the field's rules.
 */
export function filterValue(field: FieldSchema, filter: Filter): { ok: true; value: Cell } | { ok: false; reason: string } {
  const text = filter.value ?? "";
  if (filter.op === "contains" || filter.op === "not-contains") {
    return { ok: true, value: text.trim() === "" ? null : text };
  }
  return parseCellText(field, text);
}

/** Why the query can't run on these fields, for the owner; null when it can. */
export function queryProblem(query: RowQuery, fields: FieldSchema[]): string | null {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const gone = "A filter or sort uses a field that no longer exists";
  for (const filter of query.filters) {
    const field = byId.get(filter.fieldId);
    if (!field) return gone;
    if (!(FILTER_OPS[field.type] as readonly FilterOp[]).includes(filter.op)) return `“${field.name}” can't be filtered by “${filter.op}”`;
    if (!takesValue(filter.op)) continue;
    const parsed = filterValue(field, filter);
    if (!parsed.ok) return `“${field.name}”: ${parsed.reason}`;
    if (parsed.value === null) return `“${field.name}”: a value is needed`;
  }
  for (const sort of query.sort) {
    const field = byId.get(sort.fieldId);
    if (!field) return gone;
    if (field.type === "attachment") return `“${field.name}” holds files and can't be sorted`;
  }
  return null;
}
