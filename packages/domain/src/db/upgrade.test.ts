import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { closeDb, migrateDb, openDb } from "./client.ts";
import { migrateTo, PRE_UPGRADE_TAG, SEEDED_TABLES, seedPreUpgrade } from "./upgrade-fixture.ts";

async function freshDb() {
  const db = await openDb("pglite://memory");
  onTestFinished(() => closeDb(db));
  const filesDir = await mkdtemp(join(tmpdir(), "dispand-upgrade-"));
  onTestFinished(() => rm(filesDir, { recursive: true, force: true }));
  return { db, filesDir };
}

/** Every seeded table's rows, each as JSON, sorted. */
async function snapshot(db: Awaited<ReturnType<typeof openDb>>) {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const table of SEEDED_TABLES) {
    const result = await db.execute(sql.raw(`select to_jsonb(t) as r from "${table}" t order by t`));
    out[table] = (result as unknown as { rows: { r: Record<string, unknown> }[] }).rows.map((row) => row.r);
  }
  return out;
}

test("migrations run on the populated pre-upgrade fixture", async () => {
  const { db, filesDir } = await freshDb();
  await migrateTo(db, PRE_UPGRADE_TAG);
  const seeded = await seedPreUpgrade(db, filesDir);
  const before = await snapshot(db);
  expect(Object.entries(before).filter(([, rows]) => rows.length === 0).map(([table]) => table), "seeded tables left empty").toEqual([]);

  // Upgrades are plain rewrites: they may move, de-duplicate or delete rows, but must run.
  await migrateDb(db);

  for (const id of seeded.attachmentIds) {
    const result = await db.execute(sql`select owner_id from attachments where id = ${id}`);
    const { owner_id } = (result as unknown as { rows: { owner_id: string }[] }).rows[0]!;
    await access(join(filesDir, owner_id, id));
  }
});

test("migrateTo stops at the named migration", async () => {
  const { db } = await freshDb();
  await migrateTo(db, "0000_init");
  const result = await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
  expect((result as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(1);
  await expect(migrateTo(db, "no-such-tag")).rejects.toThrow("no-such-tag");
});

test("workspace settings go to the only workspace, one row kept; none with several workspaces", async () => {
  for (const [workspaces, kept] of [[1, 1], [2, 0]] as const) {
    const { db } = await freshDb();
    await migrateTo(db, "0096_user_description");
    await db.execute(sql`insert into organizations (id) values ('org')`);
    for (let i = 0; i < workspaces; i++) await db.execute(sql`insert into workspaces (id, organization_id) values (${`ws_${i}`}, 'org')`);
    await db.execute(sql`insert into "user" (id, name, email) values ('u_a', 'A', 'a@example.com'), ('u_b', 'B', 'b@example.com')`);
    await db.execute(sql`insert into workspace_settings (owner_id, checkpoint) values ('u_a', 5), ('u_b', 7)`);
    await migrateDb(db);
    const result = await db.execute(sql`select workspace_id from workspace_settings`);
    expect((result as unknown as { rows: { workspace_id: string }[] }).rows).toEqual(kept ? [{ workspace_id: "ws_0" }] : []);
  }
});

const rowsOf = async <T,>(db: Awaited<ReturnType<typeof openDb>>, query: ReturnType<typeof sql>) =>
  ((await db.execute(query)) as unknown as { rows: T[] }).rows;

/** Two people's catalogs, each with what depends on it, in `workspaces` workspaces, at 0099. */
async function twoCatalogs(workspaces: number) {
  const { db } = await freshDb();
  await migrateTo(db, "0099_agent_inboxes");
  await db.execute(sql`insert into organizations (id) values ('org')`);
  for (let i = 0; i < workspaces; i++) await db.execute(sql`insert into workspaces (id, organization_id) values (${`ws_${i}`}, 'org')`);
  const last = `ws_${workspaces - 1}`;
  for (const u of ["a", "b"]) {
    const owner = `u_${u}`;
    await db.execute(sql`insert into "user" (id, name, email) values (${owner}, ${u}, ${`${u}@example.com`})`);
    await db.execute(sql`insert into runners (id, workspace_id, owner_id, name) values (${`run_${u}`}, ${last}, ${owner}, 'box')`);
    await db.execute(sql`insert into harnesses (id, owner_id, name, type, runner_id, kind, permission_mode) values (${`cli_${u}`}, ${owner}, 'CLI', 'cli', ${`run_${u}`}, 'codex', 'default')`);
    await db.execute(sql`insert into harnesses (id, owner_id, name, type, kind, api_key_sealed) values (${`cloud_${u}`}, ${owner}, 'Cloud', 'cloud', 'anthropic', 'sealed')`);
    await db.execute(sql`insert into marketplaces (id, owner_id, name, url, built_in) values (${`mkt_${u}`}, ${owner}, 'Built-in', 'https://example.com/plugins.git', true)`);
    await db.execute(sql`insert into plugins (id, owner_id, name, description, marketplace_id, entry_name, components) values (${`plg_${u}`}, ${owner}, 'P', '', ${`mkt_${u}`}, 'p', '{}')`);
    await db.execute(sql`insert into plugins (id, owner_id, name, description, source, components) values (${`gen_${u}`}, ${owner}, 'Generated: Shop', '', 'generated', '{}')`);
    await db.execute(sql`insert into tools (id, owner_id, name, kind, url, plugin_id) values (${`ptool_${u}`}, ${owner}, 'Server', 'http', 'https://mcp.example.com', ${`plg_${u}`})`);
    await db.execute(sql`insert into tools (id, owner_id, name, kind, url, auth, oauth_sealed, oauth_status, oauth_state_hash, oauth_client_id) values
      (${`oauth_${u}`}, ${owner}, 'Server', 'http', 'https://mcp.example.com', 'oauth', 'sealed-oauth', 'connected', 'hash', 'client')`);
    await db.execute(sql`insert into skill_packages (id, owner_id, name, description, built_in) values (${`pkg_${u}`}, ${owner}, 'dispand-platform', '', true)`);
    // A table of the plugin and the person's own of the same name (and one named as a numbered copy would be): they clash once the plugin goes.
    await db.execute(sql`insert into tables (id, owner_id, name, plugin_id, plugin_component) values (${`tbl_own_${u}`}, ${owner}, 'Clients', null, null), (${`tbl_own2_${u}`}, ${owner}, 'Clients (2)', null, null), (${`tbl_a_plg_${u}`}, ${owner}, 'Clients', ${`plg_${u}`}, 'clients')`);
    // The cloud harness is used by an agent in the first workspace, the CLI one by an agent in the last.
    for (const [agent, harness, ws] of [[`ag_${u}`, `cloud_${u}`, "ws_0"], [`agcli_${u}`, `cli_${u}`, last]]) {
      await db.execute(sql`insert into agents (id, workspace_id, owner_id, name, harness_id, system_prompt) values (${agent}, ${ws}, ${owner}, 'Agent', ${harness}, '')`);
      await db.execute(sql`insert into agent_tools (agent_id, tool_id, unasked, denied) values (${agent}, ${`oauth_${u}`}, '["search"]', '["send"]'), (${agent}, ${`ptool_${u}`}, '["search"]', '[]')`);
      await db.execute(sql`insert into agent_skills (agent_id, package_id) values (${agent}, ${`pkg_${u}`})`);
    }
  }
  // `u_b`, whose ids sort last, owns the organization: theirs are the rows a collision keeps.
  await db.execute(sql`insert into organization_members (organization_id, user_id, role) values ('org', 'u_a', 'member'), ('org', 'u_b', 'owner')`);
  await db.execute(sql`insert into harnesses (id, owner_id, name, type, kind) values ('unused', 'u_a', 'Unused', 'cloud', 'openai')`);
  await migrateTo(db, "0100_catalog_workspace");
  expect(await rowsOf(db, sql`select id, name from tables where owner_id = 'u_a' order by id`)).toEqual([
    { id: "tbl_a_plg_a", name: "Clients (tbl_a_plg_a)" }, { id: "tbl_own2_a", name: "Clients (2)" }, { id: "tbl_own_a", name: "Clients" },
  ]);
  return db;
}

test("the catalog goes to the only workspace, one row kept per re-keyed name, OAuth grants cleared", async () => {
  const db = await twoCatalogs(1);
  for (const table of ["marketplaces", "plugins", "tools", "skill_packages", "harnesses"]) {
    expect(await rowsOf(db, sql.raw(`select distinct workspace_id from ${table}`)), table).toEqual([{ workspace_id: "ws_0" }]);
  }
  expect(await rowsOf(db, sql`select id from marketplaces`)).toEqual([{ id: "mkt_b" }]);
  expect(await rowsOf(db, sql`select id from plugins order by id`)).toEqual([{ id: "gen_b" }, { id: "plg_b" }]);
  expect(await rowsOf(db, sql`select id from skill_packages`)).toEqual([{ id: "pkg_b" }]);
  expect(await rowsOf(db, sql`select id from tools order by id`)).toEqual([{ id: "oauth_b" }, { id: "ptool_b" }]);
  expect(await rowsOf(db, sql`select agent_id, package_id from agent_skills order by agent_id`)).toEqual([
    { agent_id: "ag_b", package_id: "pkg_b" }, { agent_id: "agcli_b", package_id: "pkg_b" },
  ]);
  expect(await rowsOf(db, sql`select count(*)::int as n from harnesses`)).toEqual([{ n: 5 }]);
  // A new revision is a new target: what was remembered or granted for the old account no longer matches.
  expect(await rowsOf(db, sql`select distinct oauth_sealed, oauth_status, oauth_state_hash, permission_revision from tools where auth = 'oauth'`))
    .toEqual([{ oauth_sealed: null, oauth_status: "authorize", oauth_state_hash: null, permission_revision: 1 }]);
  // A reconnected account starts from asking; what was turned off stays off.
  expect(await rowsOf(db, sql`select tool_id, unasked, denied from agent_tools order by agent_id, tool_id`)).toEqual([
    { tool_id: "oauth_b", unasked: [], denied: ["send"] }, { tool_id: "ptool_b", unasked: ["search"], denied: [] },
    { tool_id: "oauth_b", unasked: [], denied: ["send"] }, { tool_id: "ptool_b", unasked: ["search"], denied: [] },
  ]);
  expect(await rowsOf(db, sql`select count(*)::int as n from agents`)).toEqual([{ n: 4 }]);
});

test("with several workspaces the catalog goes, harnesses follow their runner or agent, agents stay", async () => {
  const db = await twoCatalogs(2);
  for (const table of ["marketplaces", "plugins", "tools", "skill_packages"]) {
    expect(await rowsOf(db, sql.raw(`select count(*)::int as n from ${table}`)), table).toEqual([{ n: 0 }]);
  }
  expect(await rowsOf(db, sql`select id, workspace_id from harnesses order by id`)).toEqual([
    { id: "cli_a", workspace_id: "ws_1" }, { id: "cli_b", workspace_id: "ws_1" },
    { id: "cloud_a", workspace_id: "ws_0" }, { id: "cloud_b", workspace_id: "ws_0" },
  ]);
  expect(await rowsOf(db, sql`select count(*)::int as n from agents`)).toEqual([{ n: 4 }]);
});

/** Data of two people in `workspaces` workspaces, at 0100: tables (one naming the other), events, roots, files, memories. */
async function twoDataSets(workspaces: number) {
  const { db } = await freshDb();
  await migrateTo(db, "0100_catalog_workspace");
  await db.execute(sql`insert into organizations (id) values ('org')`);
  for (let i = 0; i < workspaces; i++) await db.execute(sql`insert into workspaces (id, organization_id) values (${`ws_${i}`}, 'org')`);
  const last = `ws_${workspaces - 1}`;
  for (const u of ["a", "b"]) {
    const owner = `u_${u}`;
    await db.execute(sql`insert into "user" (id, name, email) values (${owner}, ${u}, ${`${u}@example.com`})`);
    await db.execute(sql`insert into tables (id, owner_id, name, primitive) values (${`tbl_${u}`}, ${owner}, 'Clients', true), (${`ref_${u}`}, ${owner}, 'Orders', false)`);
    await db.execute(sql`insert into fields (id, owner_id, table_id, name, type, position, references_table_id) values (${`fld_${u}`}, ${owner}, ${`ref_${u}`}, 'Client', 'reference', 0, ${`tbl_${u}`})`);
    // A Job's root cause, named by its run and by the run's event, and a root no run names.
    await db.execute(sql`insert into roots (id, owner_id, kind) values (${`root_${u}`}, ${owner}, 'user'), (${`lone_${u}`}, ${owner}, 'event')`);
    await db.execute(sql`insert into runs (id, workspace_id, owner_id, version, status, source, root_id) values (${`run_${u}`}, ${last}, ${owner}, 1, 'running', 'agent', ${`root_${u}`})`);
    await db.execute(sql`insert into events (id, owner_id, table_id, row_id, operation, changed_field_ids, before, after, actor, root_id) values
      (${`evt_${u}`}, ${owner}, ${`tbl_${u}`}, 'row', 'created', '[]', '{}', '{}', ${JSON.stringify({ type: "job", runId: `run_${u}` })}, ${`root_${u}`}),
      (${`evt_lone_${u}`}, ${owner}, ${`tbl_${u}`}, 'row', 'created', '[]', '{}', '{}', '{"type":"user","userId":"x"}', ${`lone_${u}`})`);
    await db.execute(sql`insert into attachments (id, owner_id, table_id, job_id, name, mime, size, image) values
      (${`att_${u}`}, ${owner}, ${`tbl_${u}`}, null, 'a', 'application/octet-stream', 5, false), (${`job_att_${u}`}, ${owner}, null, ${`run_${u}`}, 'b', 'application/octet-stream', 7, false)`);
    await db.execute(sql`insert into memories (id, owner_id, scope, table_id, path, name, description, type, body, author, revision) values
      (${`mem_${u}`}, ${owner}, 'workspace', null, 'a.md', 'A', '', 'reference', '', '{"type":"user"}', 1),
      (${`tmem_${u}`}, ${owner}, 'table', ${`tbl_${u}`}, 'a.md', 'A', '', 'reference', '', '{"type":"user"}', 1)`);
  }
  await migrateDb(db);
  return db;
}

test("data goes to the only workspace and the organization counts its files' bytes", async () => {
  const db = await twoDataSets(1);
  for (const table of ["roots", "tables", "events", "attachments", "memories"]) {
    expect(await rowsOf(db, sql.raw(`select distinct workspace_id from ${table}`)), table).toEqual([{ workspace_id: "ws_0" }]);
  }
  expect(await rowsOf(db, sql`select count(*)::int as n from events`)).toEqual([{ n: 4 }]);
  expect(await rowsOf(db, sql`select files_quota_bytes::text as quota, files_used_bytes::text as used from organizations`)).toEqual([{ quota: "10737418240", used: "24" }]);
  // The counter follows every attachment written from now on.
  await db.execute(sql`delete from attachments where id = 'att_a'`);
  expect(await rowsOf(db, sql`select files_used_bytes::int as used from organizations`)).toEqual([{ used: 19 }]);
});

test("with several workspaces the data goes, a run's root and a Job's own file follow their run", async () => {
  const db = await twoDataSets(2);
  for (const table of ["tables", "events", "memories"]) {
    expect(await rowsOf(db, sql.raw(`select count(*)::int as n from ${table}`)), table).toEqual([{ n: 0 }]);
  }
  expect(await rowsOf(db, sql`select id, workspace_id from roots order by id`)).toEqual([{ id: "root_a", workspace_id: "ws_1" }, { id: "root_b", workspace_id: "ws_1" }]);
  expect(await rowsOf(db, sql`select count(*)::int as n from runs where root_id is not null`)).toEqual([{ n: 2 }]);
  expect(await rowsOf(db, sql`select id, workspace_id from attachments order by id`)).toEqual([{ id: "job_att_a", workspace_id: "ws_1" }, { id: "job_att_b", workspace_id: "ws_1" }]);
  expect(await rowsOf(db, sql`select files_used_bytes::int as used from organizations`)).toEqual([{ used: 14 }]);
});

test("pages go to the only workspace, with their widgets; none with several workspaces", async () => {
  for (const [workspaces, kept] of [[1, 1], [2, 0]] as const) {
    const { db } = await freshDb();
    await migrateTo(db, "0101_data_workspace");
    await db.execute(sql`insert into organizations (id) values ('org')`);
    for (let i = 0; i < workspaces; i++) await db.execute(sql`insert into workspaces (id, organization_id) values (${`ws_${i}`}, 'org')`);
    await db.execute(sql`insert into "user" (id, name, email) values ('u_a', 'A', 'a@example.com')`);
    await db.execute(sql`insert into pages (id, owner_id, kind, title) values ('page_a', 'u_a', 'home', 'Home')`);
    await db.execute(sql`insert into tables (id, owner_id, workspace_id, name) values ('tbl_a', 'u_a', 'ws_0', 'Clients')`);
    await db.execute(sql`insert into fields (id, owner_id, table_id, name, type, position) values ('fld_a', 'u_a', 'tbl_a', 'Name', 'text', 0)`);
    await db.execute(sql`insert into widgets (id, owner_id, page_id, type, title, table_id, config, layout) values ('wdg_a', 'u_a', 'page_a', 'table', 'Clients', 'tbl_a', '{"fieldIds":["fld_a"]}', '{}')`);
    await migrateDb(db);
    expect(await rowsOf(db, sql`select workspace_id from pages`)).toEqual(kept ? [{ workspace_id: "ws_0" }] : []);
    expect(await rowsOf(db, sql`select count(*)::int as n from widgets`)).toEqual([{ n: kept }]);
  }
});

test("audit rows go to the only workspace, none with several, and outlive their person", async () => {
  for (const [workspaces, kept] of [[1, 1], [2, 0]] as const) {
    const { db } = await freshDb();
    await migrateTo(db, "0102_pages_workspace");
    await db.execute(sql`insert into organizations (id) values ('org')`);
    for (let i = 0; i < workspaces; i++) await db.execute(sql`insert into workspaces (id, organization_id) values (${`ws_${i}`}, 'org')`);
    await db.execute(sql`insert into "user" (id, name, email) values ('u_a', 'A', 'a@example.com')`);
    await db.execute(sql`insert into audit (id, owner_id, actor, action, resource_type, result, details) values ('aud_a', 'u_a', '{"type":"user","userId":"u_a"}', 'profile.updated', 'user', 'ok', '{}')`);
    await migrateDb(db);
    expect(await rowsOf(db, sql`select workspace_id from audit`)).toEqual(kept ? [{ workspace_id: "ws_0" }] : []);
    await db.execute(sql`delete from "user"`);
    expect(await rowsOf(db, sql`select owner_id from audit`)).toEqual(kept ? [{ owner_id: null }] : []);
  }
});
