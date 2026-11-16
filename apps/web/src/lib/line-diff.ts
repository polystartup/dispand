/** A line of a diff: kept, only in the old text (`del`) or only in the new one (`add`). */
export type DiffLine = { kind: "same" | "add" | "del"; line: string };

/** What the middle of two texts may cost: the table is `old lines x new lines`. */
const MAX_CELLS = 250_000;

/**
 * The line diff of two texts (longest common subsequence over the lines between their common
 * start and end). Null when those are too many to compare cheaply: the caller shows both whole.
 */
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const x = a.slice(start, a.length - end);
  const y = b.slice(start, b.length - end);
  if (x.length * y.length > MAX_CELLS) return null;
  const lcs = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = a.slice(0, start).map((line) => ({ kind: "same", line }));
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      out.push({ kind: "same", line: x[i++]! });
      j++;
    } else if (j < y.length && (i === x.length || lcs[i]![j + 1]! > lcs[i + 1]![j]!)) out.push({ kind: "add", line: y[j++]! });
    else out.push({ kind: "del", line: x[i++]! });
  }
  return out.concat(a.slice(a.length - end).map((line) => ({ kind: "same", line })));
}
