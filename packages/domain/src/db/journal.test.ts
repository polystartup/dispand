import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// Drizzle applies a migration only if its `when` is newer than the last applied one: a rebased
// migration with an older `when` would be skipped silently on databases that have the others.
test("journal entries have increasing when and idx", () => {
  const { entries } = JSON.parse(readFileSync(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8")) as {
    entries: { idx: number; when: number; tag: string }[];
  };
  expect(entries.length).toBeGreaterThan(0);
  entries.forEach((entry, i) => {
    expect(entry.idx, entry.tag).toBe(i);
    if (i > 0) expect(entry.when, `${entry.tag} is not newer than ${entries[i - 1]!.tag}`).toBeGreaterThan(entries[i - 1]!.when);
  });
});
