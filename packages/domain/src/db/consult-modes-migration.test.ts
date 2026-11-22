import { sql } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { closeDb, migrateDb, openDb } from "./client.ts";
import { migrateTo } from "./upgrade-fixture.ts";

const rows = async (db: Awaited<ReturnType<typeof openDb>>, query: ReturnType<typeof sql>) => (await db.execute(query)) as unknown as { rows: Record<string, unknown>[] };

test("consult modes: listed agents become whitelist, flags and their Approvals go, and a profile is capped at 1,000 characters", async () => {
  const db = await openDb("pglite://memory");
  onTestFinished(() => closeDb(db));
  await migrateTo(db, "0097_settings_workspace");
  await db.execute(sql`insert into "user" (id, name, email, description) values ('u1', 'Owner', 'owner@example.com', ${"x".repeat(1200)})`);
  await db.execute(sql`insert into organizations (id) values ('o1')`);
  await db.execute(sql`insert into workspaces (id, organization_id) values ('w1', 'o1')`);
  await db.execute(sql`insert into harnesses (id, owner_id, name, type, kind, model, api_key_sealed) values ('h1', 'u1', 'Cloud', 'cloud', 'anthropic', 'claude-sonnet', 'sealed')`);
  await db.execute(sql`insert into agents (id, workspace_id, owner_id, name, harness_id, system_prompt, upstream) values
    ('a1', 'w1', 'u1', 'Asker', 'h1', '', ${JSON.stringify({ consults: [{ agentId: "a2", ask: true }] })}::jsonb),
    ('a2', 'w1', 'u1', 'Expert', 'h1', '', ${JSON.stringify({ consults: [] })}::jsonb),
    ('a3', 'w1', 'u1', 'Alone', 'h1', '', null)`);
  await db.execute(sql`insert into agent_consults (agent_id, consulted_id, ask) values ('a1', 'a2', true)`);
  await db.execute(sql`insert into runs (id, workspace_id, owner_id, source, version, status, agent_id) values ('r1', 'w1', 'u1', 'agent', 1, 'running', 'a1')`);
  const consult = { kind: "consult", agentId: "a2", question: "Which plan?" };
  const approval = { kind: "permission", toolName: "consult", input: {} };
  await db.execute(sql`insert into questions (id, owner_id, run_id, placement, kind, payload, status) values ('q1', 'u1', 'r1', 'chat', 'consult', ${JSON.stringify(consult)}::jsonb, 'pending')`);
  await db.execute(sql`insert into questions (id, owner_id, run_id, placement, kind, payload, status, consult_id) values
    ('q2', 'u1', 'r1', 'chat', 'approval', ${JSON.stringify(approval)}::jsonb, 'pending', 'q1'),
    ('q3', 'u1', 'r1', 'chat', 'approval', ${JSON.stringify(approval)}::jsonb, 'answered', 'q1')`);
  await db.execute(sql`insert into plugins (id, owner_id, name, description, components) values ('p1', 'u1', 'Firm', '', '{}')`);
  await db.execute(sql`insert into plugin_conflicts (id, owner_id, plugin_id, kind, element_id, field, status) values
    ('c1', 'u1', 'p1', 'agent', 'a1', 'consults', 'stem'),
    ('c2', 'u1', 'p1', 'agent', 'a1', 'name', 'stem')`);

  await migrateDb(db);

  expect((await rows(db, sql`select id, consult_mode, upstream from agents order by id`)).rows).toEqual([
    { id: "a1", consult_mode: "whitelist", upstream: { consults: [{ agentId: "a2" }], consultMode: "whitelist" } },
    { id: "a2", consult_mode: "disabled", upstream: { consults: [], consultMode: "disabled" } },
    { id: "a3", consult_mode: "disabled", upstream: null },
  ]);
  expect((await rows(db, sql`select * from agent_consults`)).rows).toEqual([{ agent_id: "a1", consulted_id: "a2" }]);
  // The consult that waited on its Approval is never opened: recovery opens only pending ones.
  expect((await rows(db, sql`select id, status from questions order by id`)).rows).toEqual([{ id: "q1", status: "expired" }]);
  expect((await rows(db, sql`select id from plugin_conflicts`)).rows).toEqual([{ id: "c2" }]);
  expect((await rows(db, sql`select char_length(description) as n from "user"`)).rows).toEqual([{ n: 1000 }]);
  await expect(db.execute(sql`update "user" set description = ${"y".repeat(1001)}`)).rejects.toThrow();
});
