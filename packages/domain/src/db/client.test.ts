import { sql } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { closeDb, createDb } from "./client.ts";
import { newId } from "../ids.ts";

// Both drivers return their rows under `rows`; the neutral Db type doesn't say so.
const rowsOf = (result: unknown) => (result as { rows: unknown[] }).rows;

test("createDb on pglite://memory runs queries and applies migrations", async () => {
  const db = await createDb("pglite://memory");
  onTestFinished(() => closeDb(db));
  const one = await db.execute(sql`select 1 as one`);
  expect(rowsOf(one)[0]).toEqual({ one: 1 });
  const table = await db.execute(
    sql`select table_name from information_schema.tables where table_name = '__drizzle_migrations'`,
  );
  expect(rowsOf(table)).toHaveLength(1);
});

test("newId prefixes a ulid", () => {
  expect(newId("proj")).toMatch(/^proj_[0-9A-HJKMNP-TV-Z]{26}$/);
});
