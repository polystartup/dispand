/** Values kept whole for one step (a few hundred thousand numbers at most), then summarized. */
export class Recorder {
  private readonly values = new Map<string, number[]>();

  add(name: string, value: number): void {
    let list = this.values.get(name);
    if (!list) this.values.set(name, (list = []));
    list.push(value);
  }

  /** Every series so far, summarized, and empties the recorder for the next step. */
  take(): Record<string, Summary> {
    const out = Object.fromEntries([...this.values].map(([name, list]) => [name, summarize(list)]));
    this.values.clear();
    return out;
  }
}

export type Summary = { n: number; mean: number; p50: number; p95: number; p99: number; max: number };

/** Nearest-rank percentiles. */
export function summarize(values: number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? 0;
  const mean = sorted.length ? sorted.reduce((sum, v) => sum + v, 0) / sorted.length : 0;
  return { n: sorted.length, mean, p50: at(50), p95: at(95), p99: at(99), max: sorted.at(-1) ?? 0 };
}
