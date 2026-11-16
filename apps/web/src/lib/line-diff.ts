/** A line of a diff: kept, only in the old text (`del`) or only in the new one (`add`). */
export type DiffLine = { kind: "same" | "add" | "del"; line: string };

/** The line diff of two texts (longest common subsequence): small texts only, such as an agent's instructions. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) out.push({ kind: "same", line: a[i++]! }), j++;
    else if (j < b.length && (i === a.length || lcs[i]![j + 1]! > lcs[i + 1]![j]!)) out.push({ kind: "add", line: b[j++]! });
    else out.push({ kind: "del", line: a[i++]! });
  }
  return out;
}
