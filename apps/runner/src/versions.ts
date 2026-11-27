// Apart from `sessions.ts`, which imports `codex/version.ts` that needs this.
/** Whether dotted version `v` is at least `min` (numeric parts; anything unparsable is too old). */
export function atLeast(v: string | undefined, min: string): boolean {
  const parts = (s: string) => s.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  if (!v) return false;
  const [a, b] = [parts(v), parts(min)];
  for (let i = 0; i < b.length; i++) {
    const x = a[i] ?? 0;
    if (Number.isNaN(x)) return false;
    if (x !== b[i]) return x > b[i]!;
  }
  return true;
}
