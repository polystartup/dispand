import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";

// Every WebSocket upgrade must go through the hub's guarded entry (`upgradeRunner` from
// `@dispand/domain/upgrade`): an entry that parses the URL, touches the socket or waits before
// handing it over reintroduces the crashes that entry exists to prevent.
const root = join(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(join(root, file), "utf8");

const files = (dir: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(dir, e.name))
      : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );

const entries = ["server.ts", "vite-plugin-hub.ts", "src/server.ts"];

test("the upgrade entries only hand the raw request to the guarded entry", () => {
  for (const file of entries) {
    const text = read(file);
    expect(text, file).not.toMatch(/req\.url|new URL\(req|socket\.\w+|handleUpgrade\(/);
  }
  expect(read("server.ts")).toMatch(
    /\.on\("upgrade", \(req: IncomingMessage, socket: Duplex, head: Buffer\) =>\s*built\.handleRunnerUpgrade\(req, socket, head\),?\s*\);/,
  );
  expect(read("src/server.ts")).toMatch(/\{\s*upgradeRunner\(req, socket, head, [^\n]*\);\s*\}/);
  expect(read("vite-plugin-hub.ts")).toMatch(/if \(isRunnerUpgrade\(req\)\)\s*upgradeRunner\(req, socket, head, /);
});

test("no other web file handles upgrades", () => {
  const others = [...files("src"), "vite.config.ts"]
    .filter((file) => !entries.includes(file))
    .filter((file) => /"upgrade"|handleUpgrade\(|upgradeRunner\(/.test(read(file)));
  expect(others.map((file) => relative(root, join(root, file)))).toEqual([]);
});
