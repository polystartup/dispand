import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";

// Every lock on a root's row goes through `lockRoot` (exclusive, `FOR NO KEY UPDATE`, before any
// run) or `lockRun` (a key share): no path takes a root its own way, or `FOR UPDATE`, which a
// key share waits on and which locked two roots in opposite orders once a chat moved (#463).

/** The lock modes of the `.for(…)` calls that lock `roots`: named in their `of`, or, with none, read or joined in their statement. */
function rootLocks(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return [...code.matchAll(/\.for\(\s*"([a-z ]+)"([^)]*)\)/g)].flatMap((m) => {
    const of = /\bof:\s*(\[[^\]]*\]|\w+)/.exec(m[2]!);
    const statement = code.slice(code.lastIndexOf(";", m.index) + 1, m.index);
    const locks = of ? /\broots\b/.test(of[1]!) : /\b(?:from|innerJoin|leftJoin|rightJoin|fullJoin)\(\s*roots\b/.test(statement);
    return locks ? [m[1]!] : [];
  });
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

test("the scan finds a root locked in a statement of its own", () => {
  expect(rootLocks(`await tx.select().from(roots).where(eq(roots.id, id)).for("update");`)).toEqual(["update"]);
  expect(rootLocks(`await tx.select().from(runs).innerJoin(roots, eq(roots.id, runs.rootId))\n  .for("update", { of: roots });`)).toEqual(["update"]);
  expect(rootLocks(`await tx.select().from(events).innerJoin(roots, x).for("update", { of: events, skipLocked: true });`)).toEqual([]);
  expect(rootLocks(`await tx.select().from(roots).where(x);\nawait tx.select().from(runs).for("update");`)).toEqual([]);
});

test("only lockRoot and lockRun lock a root", () => {
  const src = join(import.meta.dirname, "..");
  const locking = Object.fromEntries(
    sources(src).flatMap((file) => {
      const modes = rootLocks(readFileSync(file, "utf8"));
      return modes.length ? [[relative(src, file), modes]] : [];
    }),
  );
  expect(locking).toEqual({ "engine/step-rows.ts": ["no key update", "key share"] });
});
