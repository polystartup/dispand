import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { messageView } from "../engine/views.ts";
import type { RecordToolResult } from "../messages/record-result.ts";
import { closeDb, createDb } from "./client.ts";
import { messages } from "./schema.ts";

test("record snapshots migrate without changing legacy messages and survive database reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispand-record-result-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const before = join(dir, "migrations");
  await cp(new URL("../../drizzle", import.meta.url).pathname, before, { recursive: true });
  const journalPath = join(before, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((entry) => entry.tag < "0088");
  await writeFile(journalPath, JSON.stringify(journal));
  const url = `pglite://${join(dir, "db")}`;
  const old = await createDb(url, before);
  await old.execute(sql`insert into "user" (id, name, email) values ('user_1', 'Ada', 'ada@example.com')`);
  await old.execute(sql`insert into workflows (id, owner_id, name, current_version) values ('wf_1', 'user_1', 'Chat', 1)`);
  await old.execute(sql`insert into runs (id, owner_id, workflow_id, version, status) values ('run_1', 'user_1', 'wf_1', 1, 'running')`);
  await old.execute(sql`insert into step_runs (id, owner_id, run_id, node_id, status) values ('step_1', 'user_1', 'run_1', 'chat', 'running')`);
  await old.execute(sql`insert into messages (id, owner_id, run_id, step_run_id, role, text) values
    ('legacy', 'user_1', 'run_1', 'step_1', 'tool', 'rows_get'),
    ('card', 'user_1', 'run_1', 'step_1', 'tool', 'rows_get')`);
  await closeDb(old);
  const db = await createDb(url);
  const [legacy] = await db.select().from(messages).where(eq(messages.id, "legacy"));
  expect(legacy).toMatchObject({ text: "rows_get", toolCall: null, result: null });
  expect(messageView(legacy!)).not.toHaveProperty("result");
  const result: RecordToolResult = {
    toolCallId: "call_1", turnId: "turn_1", args: { id: "row_deleted" },
    record: { kind: "record", tableId: "table_deleted", rowId: "row_deleted", fields: [{ id: "field_1", name: "Saved name", type: "text", value: "Ada" }] },
  };
  await db.update(messages).set({ result }).where(eq(messages.id, "card"));
  await closeDb(db);
  const reopened = await createDb(url);
  onTestFinished(() => closeDb(reopened));
  const [saved] = await reopened.select().from(messages).where(eq(messages.id, "card"));
  expect(messageView(saved!).result).toEqual(result);
});
