import { readdirSync, readFileSync } from "node:fs";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { expect, test } from "vitest";
import * as schema from "./schema.ts";

const meta = new URL("../../drizzle/meta/", import.meta.url);

test("schema.ts is what the migrations make: generating one would write nothing", async () => {
  const snapshots = readdirSync(meta)
    .filter((f) => f.endsWith("_snapshot.json"))
    .sort();
  // A snapshot of a migration left out of the journal, which `migrateDb` never runs, would pass the diff below.
  // A journaled data migration may have none.
  const { entries } = JSON.parse(readFileSync(new URL("_journal.json", meta), "utf8")) as { entries: { tag: string }[] };
  const journaled = new Set(entries.map((e) => e.tag.slice(0, 4)));
  expect(
    snapshots.filter((f) => !journaled.has(f.slice(0, 4))),
    "snapshots without a journaled migration",
  ).toEqual([]);
  // drizzle-kit diffs the schema against the newest snapshot, as `db:generate` does.
  const prev = JSON.parse(readFileSync(new URL(snapshots.at(-1)!, meta), "utf8")) as Parameters<typeof generateMigration>[0];
  const statements = await generateMigration(prev, generateDrizzleJson(schema, prev.id));
  expect(statements, "schema.ts changed without its migration: run `pnpm --filter @dispand/domain db:generate`").toEqual([]);
});
