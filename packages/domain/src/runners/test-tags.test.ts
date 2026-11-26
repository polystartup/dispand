import { readdir, readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { testTags } from "./test-tags.ts";

test("every tag that skips tests on PostgreSQL is on a test", async () => {
  const src = new URL("../", import.meta.url);
  const files = (await readdir(src, { recursive: true })).filter((file) => file.endsWith(".test.ts"));
  const sources = await Promise.all(files.map((file) => readFile(new URL(file, src), "utf8")));
  for (const { name } of testTags) expect(sources.some((source) => source.includes(`"${name}"`)), name).toBe(true);
});
