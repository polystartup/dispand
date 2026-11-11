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

test("0025 keeps existing runs as workflow runs", async () => {
  const db = await createDb("pglite://memory");
  onTestFinished(() => closeDb(db));
  await db.execute(sql`insert into "user" (id, name, email) values ('user_1', 'Ada', 'ada@example.com')`);
  await db.execute(
    sql`insert into workflows (id, owner_id, name, current_version) values ('wf_1', 'user_1', 'Old', 1)`,
  );
  // A run as it was written before the migration: no source, no definition.
  await db.execute(
    sql`insert into runs (id, owner_id, workflow_id, version, status) values ('run_1', 'user_1', 'wf_1', 1, 'succeeded')`,
  );
  const run = await db.execute(sql`select source, def, agent_id, trigger_id, cause, snapshot from runs`);
  expect(rowsOf(run)[0]).toEqual({
    source: "workflow",
    def: null,
    agent_id: null,
    trigger_id: null,
    cause: null,
    snapshot: null,
  });
});

test("0047 gives existing HTTP tools with headers the headers sign-in, and every other tool none", async () => {
  const { cp, mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "dispand-0047-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  // The migrations as they were before 0047.
  const before = join(dir, "migrations");
  const all = new URL("../../drizzle", import.meta.url).pathname;
  await cp(all, before, { recursive: true });
  const journalPath = join(before, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((e) => e.tag < "0047");
  await writeFile(journalPath, JSON.stringify(journal));
  const url = `pglite://${join(dir, "db")}`;
  const old = await createDb(url, before);
  await old.execute(sql`insert into "user" (id, name, email) values ('user_1', 'Ada', 'ada@example.com')`);
  await old.execute(sql`insert into runners (id, owner_id, name, token_hash) values ('runner_1', 'user_1', 'Mac', 'h')`);
  await old.execute(
    sql`insert into tools (id, owner_id, name, kind, url, transport, headers_sealed) values
      ('tool_h', 'user_1', 'With headers', 'http', 'https://a.example/mcp', 'streamable-http', '{"authorization":"v1.x.y"}'),
      ('tool_n', 'user_1', 'Without', 'http', 'https://b.example/mcp', 'streamable-http', '{}')`,
  );
  await old.execute(sql`insert into tools (id, owner_id, name, kind, runner_id, runner_tool) values ('tool_r', 'user_1', 'On a runner', 'runner', 'runner_1', 'files')`);
  await closeDb(old);
  const db = await createDb(url);
  onTestFinished(() => closeDb(db));
  const rows = await db.execute(sql`select id, auth, oauth_sealed, oauth_status, headers_sealed from tools order by id`);
  expect(rowsOf(rows)).toEqual([
    { id: "tool_h", auth: "headers", oauth_sealed: null, oauth_status: null, headers_sealed: { authorization: "v1.x.y" } },
    { id: "tool_n", auth: "none", oauth_sealed: null, oauth_status: null, headers_sealed: {} },
    { id: "tool_r", auth: "none", oauth_sealed: null, oauth_status: null, headers_sealed: {} },
  ]);
});
