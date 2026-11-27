// The images' third-party notices (`scripts/third-party-notices.ts`), which the runner's build
// uses for its bundle: every installed package once, in npm's and pnpm's layouts.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { packageDirs, packageNotice, render } from "../../../scripts/third-party-notices.ts";

let base: string;
beforeEach(async () => (base = await mkdtemp(join(tmpdir(), "notices-"))));
afterEach(() => rm(base, { recursive: true, force: true }));

async function pkg(dir: string, name: string, files: Record<string, string> = {}) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", license: "MIT" }));
  for (const [file, text] of Object.entries(files)) await writeFile(join(dir, file), text);
}

const notices = (nodeModules: string) => packageDirs(nodeModules).flatMap((dir) => packageNotice(dir) ?? []);

test("npm's layout: nested and scoped packages, each with its licence and NOTICE, ours left out", async () => {
  const nm = join(base, "node_modules");
  await pkg(join(nm, "a"), "a", { LICENSE: "a's licence", NOTICE: "a's notice", "README.md": "no" });
  await pkg(join(nm, "a", "node_modules", "b"), "b", { "LICENCE.txt": "b's licence" });
  await pkg(join(nm, "@scope", "c"), "@scope/c");
  await pkg(join(nm, "@dispand", "domain"), "@dispand/domain", { LICENSE: "ours" });
  const found = notices(nm);
  expect(found.map((n) => n.name).sort()).toEqual(["@scope/c", "a", "b"]);
  expect(found.find((n) => n.name === "a")).toEqual({ name: "a", version: "1.0.0", identifier: "MIT", text: "a's licence\n\na's notice" });
  expect(found.find((n) => n.name === "@scope/c")?.text).toBeUndefined();
});

test("pnpm's layout: the store's packages once, through the links to them included", async () => {
  const nm = join(base, "node_modules");
  const store = join(nm, ".pnpm");
  await pkg(join(store, "a@1.0.0", "node_modules", "a"), "a", { LICENSE: "a" });
  await pkg(join(store, "b@1.0.0", "node_modules", "b"), "b", { LICENSE: "b" });
  // a's dependency b, and the top level's a: links into the store.
  await symlink(join(store, "b@1.0.0", "node_modules", "b"), join(store, "a@1.0.0", "node_modules", "b"));
  await symlink(join(store, "a@1.0.0", "node_modules", "a"), join(nm, "a"));
  expect(
    notices(nm)
      .map((n) => n.name)
      .sort(),
  ).toEqual(["a", "b"]);
});

test("the notices file lists each package once, by name", () => {
  const text = render([
    { name: "b", version: "1.0.0", identifier: "MIT", text: "b's licence" },
    { name: "a", version: "2.0.0", identifier: "Apache-2.0" },
    { name: "b", version: "1.0.0", identifier: "MIT", text: "b's licence" },
  ]);
  expect(text.match(/^## .*/gm)).toEqual(["## a 2.0.0 (Apache-2.0)", "## b 1.0.0 (MIT)"]);
  expect(text).toContain("The package holds no licence file: Apache-2.0 applies as published.");
});

test("a package listed twice keeps every distinct text it was given", () => {
  const text = render([
    { name: "a", version: "1.0.0", identifier: "MIT", text: "licence\n\nNOTICE" },
    { name: "a", version: "1.0.0", identifier: "MIT", text: "licence" },
    { name: "a", version: "1.0.0", identifier: "MIT" },
  ]);
  expect(text).toContain("## a 1.0.0 (MIT)\n\nlicence\n\nNOTICE\n\nlicence\n");
});
