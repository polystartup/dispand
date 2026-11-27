import { readdirSync, readFileSync } from "node:fs";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { expect, test } from "vitest";
import * as schema from "./schema.ts";

const meta = new URL("../../drizzle/meta/", import.meta.url);

test("schema.ts is what the migrations make: generating one would write nothing", async () => {
  // drizzle-kit diffs the schema against the newest snapshot, as `db:generate` does.
  const newest = readdirSync(meta)
    .filter((f) => f.endsWith("_snapshot.json"))
    .sort()
    .at(-1)!;
  // It must be the last migration's, or a migration left out of the journal (which `migrateDb` never runs) would pass.
  const { entries } = JSON.parse(readFileSync(new URL("_journal.json", meta), "utf8")) as { entries: { tag: string }[] };
  expect(newest, "the newest snapshot is the last journaled migration's").toBe(`${entries.at(-1)!.tag.slice(0, 4)}_snapshot.json`);
  const prev = JSON.parse(readFileSync(new URL(newest, meta), "utf8")) as Parameters<typeof generateMigration>[0];
  const statements = await generateMigration(prev, generateDrizzleJson(schema, prev.id));
  expect(statements, "schema.ts changed without its migration: run `pnpm --filter @dispand/domain db:generate`").toEqual([]);
});
