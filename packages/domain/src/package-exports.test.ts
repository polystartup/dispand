// The package's subpaths are listed one by one, twice: `exports` for the workspace, and
// `publishConfig.exports` for the packed package, which is what another server installs.
import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

const manifest: { exports: Record<string, string>; publishConfig: { exports: Record<string, string> } } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const listed = Object.entries(manifest.exports);

test("each export names one file that exists, never a pattern", () => {
  for (const [subpath, source] of listed) {
    expect(`${subpath} ${source}`).not.toContain("*");
    expect(existsSync(new URL(`../${source}`, import.meta.url)), subpath).toBe(true);
  }
});

test("the packed package exports the compiled form of every export but the test helpers", () => {
  const compiled = listed
    .filter(([subpath]) => !subpath.startsWith("./test-"))
    .map(([subpath, source]) => [subpath, source.replace("./src/", "./dist/").replace(/\.ts$/, ".js")]);
  expect(manifest.publishConfig.exports).toEqual(Object.fromEntries(compiled));
});
