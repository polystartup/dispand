// `pnpm bench:load:profile <file.cpuprofile>`: where the app's CPU went, from a `--cpu-prof` run.
// Self time by function and by package, and total time (the function and what it called) by function.
import { readFileSync } from "node:fs";

type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] };
type Profile = { nodes: Node[]; samples: number[]; timeDeltas: number[] };

/** Time per function name, location and package, from a V8 CPU profile. */
export function hotspots(profile: Profile) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const self = new Map<number, number>();
  profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000));

  const name = ({ callFrame: f }: Node) => `${f.functionName || "(anonymous)"} ${f.url.replace(/^.*\/node_modules\//, "")}:${f.lineNumber + 1}`;
  // The last node_modules is the package's own (pnpm nests them under .pnpm).
  const pkg = ({ callFrame: { url, functionName } }: Node) =>
    /.*node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(url)?.[1] ??
    (url.startsWith("node:")
      ? "node"
      : url
        ? url
            .replace(/^.*\/(dist|src)\//, "$1/")
            .split("/")
            .slice(0, 2)
            .join("/")
        : functionName);
  const add = (map: Map<string, number>, key: string, ms: number) => map.set(key, (map.get(key) ?? 0) + ms);

  const selfByName = new Map<string, number>();
  const selfByPackage = new Map<string, number>();
  const totalByName = new Map<string, number>();
  let all = 0;
  let idle = 0;
  for (const [id, ms] of self) {
    const node = byId.get(id)!;
    // Waiting isn't CPU: it is reported apart, out of the shares.
    if (node.callFrame.functionName === "(idle)") {
      idle += ms;
      continue;
    }
    all += ms;
    add(selfByName, name(node), ms);
    add(selfByPackage, pkg(node), ms);
    // Each function on the sample's stack once, however often it recursed.
    const onStack = new Set<string>();
    for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) onStack.add(name(byId.get(at)!));
    for (const key of onStack) add(totalByName, key, ms);
  }
  const top = (map: Map<string, number>, n: number) =>
    [...map]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([key, ms]) => ({ key, ms, share: ms / all }));
  return { totalMs: all, idleMs: idle, selfByName: top(selfByName, 30), selfByPackage: top(selfByPackage, 20), totalByName: top(totalByName, 40) };
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const file = process.argv[2];
  if (!file) throw new Error("usage: pnpm bench:load:profile <file.cpuprofile>");
  const result = hotspots(JSON.parse(readFileSync(file, "utf8")) as Profile);
  const print = (title: string, rows: { key: string; ms: number; share: number }[]) => {
    console.log(`\n${title}`);
    for (const row of rows) console.log(`${(row.share * 100).toFixed(1).padStart(5)}%  ${(row.ms / 1000).toFixed(1).padStart(7)} s  ${row.key}`);
  };
  console.log(`${(result.totalMs / 1000).toFixed(1)} s sampled busy (not all of it CPU: see the run for that), ${(result.idleMs / 1000).toFixed(1)} s idle`);
  print("Self time by package", result.selfByPackage);
  print("Self time by function", result.selfByName);
  print("Total time by function (itself and what it called)", result.totalByName);
}
