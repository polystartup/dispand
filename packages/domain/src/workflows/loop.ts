import { OutputField } from "@dispand/runner-protocol";
import { storableText } from "../text.ts";

// Pure: imported by the web editor too (`@dispand/domain/workflows/loop`).

/** What a loop gives the steps after it; inside its body it gives `item`, `index` and an object item's fields. */
export const LOOP_OUTPUTS = ["count", "results"] as const;

/** The most iterations a loop may run, and a new loop's. */
export const MAX_ITERATIONS = 100;
export const DEFAULT_ITERATIONS = 20;

/** The longest `results` a loop may give (characters): over it, the loop fails rather than store it. */
export const MAX_RESULTS = 1_000_000;

/** The items of a loop's list: a JSON array, nothing else. */
export function parseList(value: string): { items: unknown[] } | { error: string } {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return { items: parsed };
  } catch {
    // Not JSON: not a list either.
  }
  return { error: "is not a list (a JSON array)" };
}

// A decoded string may hold what its JSON escaped (NUL, a lone surrogate): made storable. JSON is.
const asText = (value: unknown) => (typeof value === "string" ? storableText(value) : JSON.stringify(value));

/**
 * What a body step reads from its loop in one iteration: `item` (the text, or JSON for any other
 * value), `index` (from 1) and, for an object item, each top-level field that can name a value.
 */
export function itemValues(item: unknown, index: number): Record<string, string> {
  const values: Record<string, string> = { item: asText(item), index: String(index + 1) };
  if (item === null || typeof item !== "object" || Array.isArray(item)) return values;
  for (const [key, value] of Object.entries(item)) {
    // A reserved name (`__proto__`…) never becomes a key here.
    if (key !== "item" && key !== "index" && OutputField.shape.name.safeParse(key).success) values[key] = asText(value);
  }
  return values;
}

/** A loop's `results`: one object per iteration, its succeeded body steps' outputs by key. */
export function loopResults(iterations: Record<string, Record<string, string>>[]): string {
  return JSON.stringify(iterations);
}
