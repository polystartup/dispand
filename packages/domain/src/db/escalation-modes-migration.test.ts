import { sql } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { closeDb, openDb } from "./client.ts";
import { migrateTo } from "./upgrade-fixture.ts";

const rows = async (db: Awaited<ReturnType<typeof openDb>>, query: ReturnType<typeof sql>) => (await db.execute(query)) as unknown as { rows: Record<string, unknown>[] };

test("escalation modes: every agent keeps asking its creator, as a whitelist holding them, and a plugin's values gain the fields", async () => {
  const db = await openDb("pglite://memory");
  onTestFinished(() => closeDb(db));
  await migrateTo(db, "0109_workspace_limit");
  await db.execute(sql`insert into "user" (id, name, email) values ('u1', 'Owner', 'owner@example.com')`);
  await db.execute(sql`insert into organizations (id) values ('o1')`);
  await db.execute(sql`insert into workspaces (id, organization_id) values ('w1', 'o1')`);
  await db.execute(sql`insert into harnesses (id, workspace_id, owner_id, name, type, kind, model, api_key_sealed) values ('h1', 'w1', 'u1', 'Cloud', 'cloud', 'anthropic', 'claude-sonnet', 'sealed')`);
  await db.execute(sql`insert into agents (id, workspace_id, owner_id, name, harness_id, system_prompt, upstream) values
    ('a1', 'w1', 'u1', 'Plugin agent', 'h1', '', ${JSON.stringify({ consultMode: "disabled" })}::jsonb),
    ('a2', 'w1', 'u1', 'Own agent', 'h1', '', null)`);

  await migrateTo(db, "0110_escalation_modes");

  expect((await rows(db, sql`select id, escalate_mode, prefer_agents, upstream from agents order by id`)).rows).toEqual([
    { id: "a1", escalate_mode: "whitelist", prefer_agents: false, upstream: { consultMode: "disabled", escalateMode: "whitelist", preferAgents: false } },
    { id: "a2", escalate_mode: "whitelist", prefer_agents: false, upstream: null },
  ]);
  expect((await rows(db, sql`select agent_id, user_id from agent_escalations order by agent_id`)).rows).toEqual([
    { agent_id: "a1", user_id: "u1" },
    { agent_id: "a2", user_id: "u1" },
  ]);
  await expect(db.execute(sql`update agents set escalate_mode = 'sometimes'`)).rejects.toThrow();
});
