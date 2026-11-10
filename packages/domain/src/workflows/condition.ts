// Pure: imported by the web editor too (`@dispand/domain/workflows/condition`).

export const CONDITION_OPS = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "is_empty",
  "is_not_empty",
  "greater_than",
  "less_than",
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

/** What a condition gives the steps after it. */
export const CONDITION_OUTPUTS = ["matched"] as const;

function asNumber(text: string): number | null {
  return text === "" ? null : Number.isNaN(Number(text)) ? null : Number(text);
}

/**
 * Whether `value` passes `op` against `operand`. Both sides are trimmed; text comparisons ignore
 * case. A greater/less comparison needs two numbers: anything else is an error for the owner,
 * never a silent "else".
 */
export function evaluateCondition(op: ConditionOp, value: string, operand: string): { matched: boolean } | { error: string } {
  const a = value.trim();
  const b = operand.trim();
  const lower = (s: string) => s.toLocaleLowerCase("fr");
  switch (op) {
    case "equals":
      return { matched: lower(a) === lower(b) };
    case "not_equals":
      return { matched: lower(a) !== lower(b) };
    case "contains":
      return { matched: lower(a).includes(lower(b)) };
    case "not_contains":
      return { matched: !lower(a).includes(lower(b)) };
    case "is_empty":
      return { matched: a === "" };
    case "is_not_empty":
      return { matched: a !== "" };
    case "greater_than":
    case "less_than": {
      const x = asNumber(a);
      const y = asNumber(b);
      for (const [n, text] of [[x, a], [y, b]] as const) {
        if (n === null) return { error: `“${Array.from(text).slice(0, 80).join("")}” is not a number` };
      }
      return { matched: op === "greater_than" ? x! > y! : x! < y! };
    }
  }
}
