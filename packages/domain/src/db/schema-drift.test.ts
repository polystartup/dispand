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
  const prev = JSON.parse(readFileSync(new URL(newest, meta), "utf8")) as Parameters<typeof generateMigration>[0];
  const statements = await generateMigration(prev, generateDrizzleJson(schema, prev.id));
  expect(statements, "schema.ts changed without its migration: run `pnpm --filter @dispand/domain db:generate`").toEqual([]);
});
