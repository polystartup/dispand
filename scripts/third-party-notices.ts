// The third-party notices of what an image ships, written at build time: every package installed
// under the given node_modules folders (npm's and pnpm's layouts), and the packages a bundle holds
// (Vite's `build.license` JSON, or the runner's build, which lists its bundle the same way), each
// with its licence and NOTICE files. Our own packages (@dispand/*) are left out.
// Usage: node scripts/third-party-notices.ts <out.md> <node_modules folder | package folder | notices .json>...
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One package's notice: Vite's `build.license` JSON entry. */
export type Notice = { name: string; version: string; identifier?: string; text?: string };

const FILES = /^(licen[cs]e|copying|notice)/i;

/** The notice of the package in `dir`, none for our own. */
export function packageNotice(dir: string): Notice | undefined {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string; license?: string | { type?: string } };
  if (!pkg.name || pkg.name.startsWith("@dispand/")) return undefined;
  const files = readdirSync(dir)
    .filter((f) => FILES.test(f) && statSync(join(dir, f)).isFile())
    .sort();
  const text = files.map((f) => readFileSync(join(dir, f), "utf8").trim()).join("\n\n");
  const identifier = typeof pkg.license === "string" ? pkg.license : pkg.license?.type;
  return { name: pkg.name, version: pkg.version ?? "0.0.0", ...(identifier ? { identifier } : {}), ...(text ? { text } : {}) };
}

/** The folder of every package installed under `nodeModules`, at any depth, each once. */
export function packageDirs(nodeModules: string, seen = new Set<string>()): string[] {
  if (!existsSync(nodeModules) || seen.has(realpathSync(nodeModules))) return [];
  seen.add(realpathSync(nodeModules));
  return readdirSync(nodeModules).flatMap((entry) => {
    const path = join(nodeModules, entry);
    // pnpm's store: each package in `<id>/node_modules`, beside links to its dependencies.
    if (entry === ".pnpm") return readdirSync(path).flatMap((id) => packageDirs(join(path, id, "node_modules"), seen));
    if (entry.startsWith(".")) return [];
    if (entry.startsWith("@")) return readdirSync(path).flatMap((name) => packageAt(join(path, name), seen));
    return packageAt(path, seen);
  });
}

function packageAt(dir: string, seen: Set<string>): string[] {
  if (!existsSync(join(dir, "package.json"))) return [];
  const real = realpathSync(dir);
  if (seen.has(real)) return [];
  seen.add(real);
  return [real, ...packageDirs(join(real, "node_modules"), seen)];
}

/** The notices file: each package once, by name and version, with every distinct text it was given. */
export function render(notices: Notice[]): string {
  const unique = new Map<string, Notice>();
  for (const n of notices) {
    const key = `${n.name}@${n.version}`;
    const seen = unique.get(key);
    const texts = [...new Set([seen?.text, n.text].filter((t) => t !== undefined))];
    unique.set(key, { ...seen, ...n, ...(texts.length ? { text: texts.join("\n\n") } : {}) });
  }
  const sorted = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const sections = sorted.map((n) => {
    const head = `## ${n.name} ${n.version}${n.identifier ? ` (${n.identifier})` : ""}`;
    return `${head}\n\n${n.text ?? `The package holds no licence file: ${n.identifier ?? "its licence"} applies as published.`}\n`;
  });
  return [
    "# Third-party notices",
    "",
    "This image ships the software below, each under its own licence. The base image's software",
    "carries its notices where it is installed: Node.js in /usr/local/LICENSE, the Debian packages",
    "in /usr/share/doc.",
    "",
    ...sections,
  ].join("\n");
}

if (import.meta.main) {
  const [out, ...inputs] = process.argv.slice(2);
  if (!out || inputs.length === 0) throw new Error("usage: third-party-notices.ts <out.md> <node_modules folder | package folder | notices .json>...");
  const notices = inputs.flatMap((input) => {
    if (input.endsWith(".json")) return (JSON.parse(readFileSync(input, "utf8")) as Notice[]).filter((n) => !n.name.startsWith("@dispand/"));
    // A package itself: one a bundle holds that its list misses (a stylesheet's).
    if (existsSync(join(input, "package.json"))) return packageNotice(realpathSync(input)) ?? [];
    return packageDirs(input).flatMap((dir) => packageNotice(dir) ?? []);
  });
  writeFileSync(out, render(notices));
}
