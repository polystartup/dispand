import { describe, expect, it } from "vitest";
import { deliver, type Watched } from "./load.ts";
import { hotspots } from "./profile.ts";
import { summarize } from "./stats.ts";

describe("summarize", () => {
  it("takes nearest-rank percentiles", () => {
    const s = summarize(Array.from({ length: 100 }, (_, i) => 100 - i));
    expect(s).toMatchObject({ n: 100, p50: 50, p95: 95, p99: 99, max: 100, mean: 50.5 });
    expect(summarize([])).toMatchObject({ n: 0, p99: 0 });
  });
});

describe("deliver", () => {
  it("counts a delta delivered once the text holds its end, folded deltas together", () => {
    const turn: Watched = {
      emitted: [
        [10, 0],
        [20, 5],
        [30, 7],
      ],
      done: false,
      delivered: 0,
      seen: 0,
    };
    expect(deliver(turn, 9, 50)).toEqual({ grew: 9, latencies: [] });
    expect(deliver(turn, 25, 60)).toEqual({ grew: 16, latencies: [60, 55] });
    // A stale, shorter update delivers nothing again.
    expect(deliver(turn, 12, 70)).toEqual({ grew: 0, latencies: [] });
    expect(deliver(turn, 30, 80)).toEqual({ grew: 5, latencies: [73] });
    expect(turn.delivered).toBe(3);
  });
});

describe("hotspots", () => {
  it("splits self and total time by function and package", () => {
    const frame = (functionName: string, url: string) => ({ functionName, url, lineNumber: 0 });
    const profile = {
      nodes: [
        { id: 1, callFrame: frame("(root)", ""), children: [2, 4] },
        { id: 2, callFrame: frame("handle", "file:///app/dist/server/a.js"), children: [3] },
        { id: 3, callFrame: frame("parse", "file:///app/node_modules/.pnpm/zod@4.0.0/node_modules/zod/index.js") },
        { id: 4, callFrame: frame("(idle)", "") },
      ],
      samples: [2, 3, 3, 3, 4],
      timeDeltas: [1000, 1000, 1000, 1000, 5000],
    };
    const result = hotspots(profile);
    expect(result).toMatchObject({ totalMs: 4, idleMs: 5 });
    expect(result.selfByPackage[0]).toMatchObject({ key: "zod", ms: 3 });
    expect(result.totalByName.find((row) => row.key.startsWith("handle"))).toMatchObject({ ms: 4, share: 1 });
  });
});
