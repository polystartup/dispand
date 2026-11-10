import { z } from "zod";

// Every string, array, record and free-form value in the protocol has a bound. Zod checks an
// array's length before its items, so a huge array costs one issue, not one per item; records and
// free-form values get the same early check here. `messages.test.ts` walks the schemas to keep it so.

/** Ids, names, versions. */
export const ID = 200;
/** Labels, headers, descriptions, questions, error messages. */
export const SHORT = 4000;
/** Prompts, chat text, text deltas, results, output values. */
export const TEXT = 200_000;
/** A permission prompt's tool input, serialized. */
export const PERMISSION_INPUT = 256 * 1024;

/**
 * Whether Postgres text and JSONB can hold `s`: well-formed UTF-16 (no lone surrogate, which has
 * no UTF-8 form) and no U+0000. The one rule for every protocol string, record key and JSON value.
 */
export function storable(s: string): boolean {
  return s.isWellFormed() && !s.includes("\u0000");
}

/** A protocol string: at most `max` characters, and storable. Every string in the protocol is one of these. */
export const string = (max: number) => z.string().max(max).refine(storable, "not storable (NUL or a lone surrogate)");
export const id = () => string(ID);
export const short = () => string(SHORT);
export const text = () => string(TEXT);

/** Whether every string and key in a JSON value is storable. */
function storableJson(value: unknown): boolean {
  if (typeof value === "string") return storable(value);
  if (Array.isArray(value)) return value.every(storableJson);
  if (typeof value === "object" && value !== null) return Object.entries(value).every(([k, v]) => storable(k) && storableJson(v));
  return true;
}

/** Schemas whose bound Zod can't show: a record's entry count or a free-form value's size. */
export const bounded = z.registry<{ max: number }>();

/** A record of at most `max` entries, refused before its entries are parsed. Keys are ids unless `key` says otherwise. */
export function record<V extends z.ZodType>(value: V, max: number, key: z.ZodString = id()) {
  const schema = z
    .unknown()
    .check((ctx) => {
      const v = ctx.value;
      if (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length > max) {
        ctx.issues.push({ code: "custom", message: `at most ${max} entries`, input: v, abort: true });
      }
    })
    .pipe(z.record(key, value));
  bounded.add(schema, { max });
  return schema;
}

/** Any JSON value of at most `maxBytes` once serialized, every string and key storable. */
export function json(maxBytes: number) {
  const schema = z.unknown().check((ctx) => {
    if ((JSON.stringify(ctx.value) ?? "").length > maxBytes) {
      ctx.issues.push({ code: "custom", message: `at most ${maxBytes} bytes`, input: ctx.value, abort: true });
    } else if (!storableJson(ctx.value)) {
      ctx.issues.push({ code: "custom", message: "not storable (NUL or a lone surrogate)", input: ctx.value, abort: true });
    }
  });
  bounded.add(schema, { max: maxBytes });
  return schema;
}

/** A JSON object of at most `maxBytes` once serialized, as `json` checks it. */
export function jsonObject(maxBytes: number) {
  const schema = json(maxBytes).check((ctx) => {
    const v = ctx.value;
    if (typeof v !== "object" || v === null || Array.isArray(v)) ctx.issues.push({ code: "custom", message: "must be an object", input: v, abort: true });
  }) as unknown as z.ZodType<Record<string, unknown>>;
  bounded.add(schema, { max: maxBytes });
  return schema;
}
