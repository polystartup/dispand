import { storable } from "@dispand/runner-protocol";
import { z } from "zod";
import { StorableText } from "../text.ts";

// Field types and cell values: the one place that knows what each type stores, how text becomes a
// cell (a wired agent output, a literal, a retype) and how a cell becomes text again. Pure, so the
// web app, the procedures and the engine all apply the same rules.

export const FIELD_TYPES = ["text", "long-text", "number", "checkbox", "date", "url", "attachment", "single-select", "reference"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const CELL_LIMITS = { text: 10_000, "long-text": 100_000, url: 2_000, attachments: 20 } as const;
export const MAX_CHOICES = 100;
const MAX_HINT = 3000;

export const Choice = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  label: StorableText(100).trim().min(1),
});
export type Choice = z.infer<typeof Choice>;

/** `referencesTableId`: for a reference field, the table whose rows it names. */
export type FieldSchema = { id: string; name: string; type: FieldType; choices: Choice[]; referencesTableId?: string | null };

/** What a row's id looks like: a reference cell holds one. Whether it names a row is `writeRow`'s check. */
export const ROW_ID = /^row_[0-9A-Za-z]{1,64}$/;

/** text, long-text, url, date: a string; number: finite; checkbox: boolean; single-select: a choice id; attachment: attachment ids; reference: a row id. `null` is empty. */
export type Cell = string | number | boolean | string[] | null;

type Parsed = { ok: true; value: Cell } | { ok: false; reason: string };

function isDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= days[mo - 1]!;
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** What the grid sends: strict, no coercion. */
export function cellSchema(field: FieldSchema): z.ZodType<Cell> {
  switch (field.type) {
    case "text":
      return StorableText(CELL_LIMITS.text).nullable();
    case "long-text":
      return StorableText(CELL_LIMITS["long-text"]).nullable();
    case "url":
      return StorableText(CELL_LIMITS.url).refine(isHttpUrl, "expected an http(s) URL").nullable();
    case "date":
      return z.string().refine(isDate, "expected a date, YYYY-MM-DD").nullable();
    case "number":
      return z.number().finite().nullable();
    case "checkbox":
      return z.boolean().nullable();
    case "single-select": {
      const ids = new Set(field.choices.map((c) => c.id));
      return z
        .string()
        .refine((id) => ids.has(id), "not one of the field's choices")
        .nullable();
    }
    case "attachment":
      return z.array(StorableText(200)).max(CELL_LIMITS.attachments).nullable();
    case "reference":
      return z.string().regex(ROW_ID, "expected the id of a row").nullable();
  }
}

/** The first `max` characters of `s`, never splitting a surrogate pair (a lone half isn't storable). */
function cut(s: string, max: number): string {
  const head = s.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

/** The value as the owner reads it in a reason: quoted, and cut so a long output stays short. */
function quote(text: string): string {
  return `“${text.length > 100 ? `${cut(text, 100)}…` : text}”`;
}

function textCell(text: string, max: number): Parsed {
  if (text.length > max) return { ok: false, reason: `expected at most ${max} characters, got ${text.length}` };
  if (!storable(text)) return { ok: false, reason: "contains a character Dispand can't store (NUL or a lone surrogate)" };
  return { ok: true, value: text };
}

const TRUE = new Set(["true", "yes", "y", "1", "x", "checked"]);
const FALSE = new Set(["false", "no", "n", "0", "unchecked"]);
const ISO_DATE_TIME = /^(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?$/i;

/** What a wired value or a literal goes through: lenient, with an owner-facing reason when it doesn't fit. */
export function parseCellText(field: FieldSchema, text: string): Parsed {
  const t = text.trim();
  if (t === "") return { ok: true, value: null };
  switch (field.type) {
    case "text":
      return textCell(text, CELL_LIMITS.text);
    case "long-text":
      return textCell(text, CELL_LIMITS["long-text"]);
    case "number": {
      let n = t.replace(/\s/g, "");
      if (n.split(",").length === 2 && !n.includes(".")) n = n.replace(",", ".");
      const value = Number(n);
      if (!/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(n) || !Number.isFinite(value)) return { ok: false, reason: `expected a number, got ${quote(t)}` };
      return { ok: true, value };
    }
    case "checkbox": {
      const v = t.toLowerCase();
      if (TRUE.has(v)) return { ok: true, value: true };
      if (FALSE.has(v)) return { ok: true, value: false };
      return { ok: false, reason: `expected true or false, got ${quote(t)}` };
    }
    case "date": {
      const date = ISO_DATE_TIME.exec(t)?.[1] ?? t;
      if (!isDate(date)) return { ok: false, reason: `expected a date, YYYY-MM-DD, got ${quote(t)}` };
      return { ok: true, value: date };
    }
    case "url":
      if (t.length > CELL_LIMITS.url || !storable(t) || !isHttpUrl(t)) return { ok: false, reason: `expected an http(s) URL, got ${quote(t)}` };
      return { ok: true, value: t };
    case "single-select": {
      const choice = field.choices.find((c) => c.label.toLowerCase() === t.toLowerCase());
      if (!choice) return { ok: false, reason: `expected one of the field's choices, got ${quote(t)}` };
      return { ok: true, value: choice.id };
    }
    case "attachment":
      return { ok: false, reason: "files can't be set from text" };
    case "reference":
      return ROW_ID.test(t) ? { ok: true, value: t } : { ok: false, reason: `expected the id of a row, got ${quote(t)}` };
  }
}

/** A cell as text: what a retype parses and what a workflow wires into a prompt. */
export function cellText(field: FieldSchema, value: Cell, attachmentNames: Record<string, string> = {}): string {
  if (value === null) return "";
  if (Array.isArray(value)) return value.map((id) => attachmentNames[id] ?? id).join(", ");
  if (field.type === "single-select") return field.choices.find((c) => c.id === value)?.label ?? "";
  return String(value);
}

const isEmpty = (cell: Cell) => cell === null || cell === "" || (Array.isArray(cell) && cell.length === 0);

/**
 * The retype rule: each cell goes through `parseCellText(to, cellText(from, cell))`. To a single
 * select, each distinct text first becomes a choice (in order of first appearance, up to 100).
 * `cleared` counts the non-empty cells that became `null`.
 */
export function convertCells(
  cells: Cell[],
  from: FieldSchema,
  to: FieldSchema,
  makeId: () => string,
  attachmentNames: Record<string, string> = {},
): { cells: Cell[]; cleared: number; choices: Choice[] } {
  const choices = to.type === "single-select" ? [...to.choices] : [];
  let cleared = 0;
  const convert = (cell: Cell): Cell => {
    if (isEmpty(cell)) return null;
    if (from.type === to.type && to.type !== "single-select") return cell;
    // Files and references come from what they name, never from text: a retype to one clears.
    if (to.type === "attachment" || to.type === "reference") return null;
    if (to.type === "single-select") {
      if (from.type === "single-select") return choices.some((c) => c.id === cell) ? cell : null;
      const label = cellText(from, cell, attachmentNames).trim();
      const found = choices.find((c) => c.label.toLowerCase() === label.toLowerCase());
      if (found) return found.id;
      const choice = { id: makeId(), label };
      if (choices.length >= MAX_CHOICES || !Choice.safeParse(choice).success) return null;
      choices.push(choice);
      return choice.id;
    }
    const parsed = parseCellText(to, cellText(from, cell, attachmentNames));
    return parsed.ok ? parsed.value : null;
  };
  const out = cells.map((cell) => {
    const value = convert(cell);
    if (value === null && !isEmpty(cell)) cleared++;
    return value;
  });
  return { cells: out, cleared, choices };
}

/** What a field takes, for an agent's expected-output description. At most 3000 characters. */
export function typeHint(field: FieldSchema): string {
  switch (field.type) {
    case "text":
      return "text";
    case "long-text":
      return "long text";
    case "number":
      return "a number";
    case "checkbox":
      return "true or false";
    case "date":
      return "a date, YYYY-MM-DD";
    case "url":
      return "an http(s) URL";
    case "attachment":
      return "files";
    case "reference":
      return "the id of a row (row_…)";
    case "single-select": {
      const hint = `one of: ${field.choices.map((c) => c.label).join(", ")}`;
      return hint.length > MAX_HINT ? `${cut(hint, MAX_HINT - 1)}…` : hint;
    }
  }
}
