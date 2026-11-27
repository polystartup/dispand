// The app image's third-party notices (`Dockerfile`): Vite's licence lists cover what its bundles'
// scripts hold, not what its stylesheet takes in, which the Dockerfile names one by one.
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

test("every package the stylesheet takes in is in the app image's notices", async () => {
  const css = await readFile("src/styles.css", "utf8");
  const packages = new Set([...css.matchAll(/(?:@import|url\()\s*"((?:@[^/"]+\/)?[^./"][^/"]*)/g)].map((m) => m[1]));
  expect([...packages].sort()).toEqual(["@fontsource-variable/hanken-grotesk", "tailwindcss", "tw-animate-css"]);
  const dockerfile = await readFile("../../Dockerfile", "utf8");
  for (const name of packages) expect(dockerfile).toContain(`apps/web/node_modules/${name}`);
});
