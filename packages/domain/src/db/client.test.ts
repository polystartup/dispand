import { sql } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { closeDb, createDb, migrateDb, openDb } from "./client.ts";
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

test("openDb leaves the schema alone until migrateDb applies it", async () => {
  const db = await openDb("pglite://memory");
  onTestFinished(() => closeDb(db));
  const tables = sql`select table_name from information_schema.tables where table_schema = 'public'`;
  expect(rowsOf(await db.execute(tables))).toHaveLength(0);
  await migrateDb(db);
  expect(rowsOf(await db.execute(tables)).length).toBeGreaterThan(0);
});

test("newId prefixes a ulid", () => {
  expect(newId("proj")).toMatch(/^proj_[0-9A-HJKMNP-TV-Z]{26}$/);
});

test("0025 keeps existing runs as workflow runs", async () => {
  const db = await createDb("pglite://memory");
  onTestFinished(() => closeDb(db));
  await db.execute(sql`insert into "user" (id, name, email) values ('user_1', 'Ada', 'ada@example.com')`);
  await db.execute(sql`insert into organizations (id) values ('org_1')`);
  await db.execute(sql`insert into workspaces (id, organization_id) values ('ws_1', 'org_1')`);
  await db.execute(
    sql`insert into workflows (id, workspace_id, owner_id, name, current_version) values ('wf_1', 'ws_1', 'user_1', 'Old', 1)`,
  );
  // Omitting the source and definition still creates a workflow run.
  await db.execute(
    sql`insert into runs (id, workspace_id, owner_id, workflow_id, version, status) values ('run_1', 'ws_1', 'user_1', 'wf_1', 1, 'succeeded')`,
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

test("0071 gives a plugin's existing agents and tools the values they have as their plugin's, and leaves the owner's own alone", async () => {
  const { cp, mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "dispand-0071-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  // The migrations as they were before 0071.
  const before = join(dir, "migrations");
  await cp(new URL("../../drizzle", import.meta.url).pathname, before, { recursive: true });
  const journalPath = join(before, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((e) => e.tag < "0071");
  await writeFile(journalPath, JSON.stringify(journal));
  const url = `pglite://${join(dir, "db")}`;
  const old = await createDb(url, before);
  await old.execute(sql`insert into "user" (id, name, email) values ('user_1', 'Ada', 'ada@example.com')`);
  await old.execute(sql`insert into plugins (id, owner_id, name, description, components) values ('plugin_1', 'user_1', 'github', '', '{"skills":[],"mcpServers":[],"agents":[]}')`);
  await old.execute(sql`insert into harnesses (id, owner_id, name, type, kind) values ('harness_1', 'user_1', 'API', 'cloud', 'anthropic')`);
  await old.execute(
    sql`insert into tools (id, owner_id, name, kind, url, transport, plugin_id, plugin_component) values
      ('tool_p', 'user_1', 'github', 'http', 'https://a.example/mcp', 'streamable-http', 'plugin_1', 'github'),
      ('tool_o', 'user_1', 'mine', 'http', 'https://b.example/mcp', 'streamable-http', null, null)`,
  );
  await old.execute(
    sql`insert into agents (id, owner_id, name, harness_id, system_prompt, plugin_id, plugin_component) values
      ('agent_p', 'user_1', 'reviewer', 'harness_1', 'Review.', 'plugin_1', 'reviewer'),
      ('agent_o', 'user_1', 'Mine', 'harness_1', 'Mine.', null, null)`,
  );
  await old.execute(sql`insert into agent_tools (agent_id, tool_id) values ('agent_p', 'tool_p')`);
  await old.execute(sql`insert into agent_consults (agent_id, consulted_id, ask) values ('agent_p', 'agent_o', true)`);
  await closeDb(old);
  const db = await createDb(url);
  onTestFinished(() => closeDb(db));
  expect(rowsOf(await db.execute(sql`select id, upstream, overridden from tools order by id`))).toEqual([
    { id: "tool_o", upstream: null, overridden: [] },
    { id: "tool_p", upstream: { name: "github", url: "https://a.example/mcp", transport: "streamable-http" }, overridden: [] },
  ]);
  // As every later migration leaves it: 0098 drops the flag and adds the consult mode.
  expect(rowsOf(await db.execute(sql`select id, upstream, overridden from agents order by id`))).toEqual([
    { id: "agent_o", upstream: null, overridden: [] },
    {
      id: "agent_p",
      upstream: { name: "reviewer", description: "", systemPrompt: "Review.", bundles: [], dataTables: "all", selfLearning: [], skillPackageIds: [], toolIds: ["tool_p"], consults: [{ agentId: "agent_o" }], consultMode: "whitelist" },
      overridden: [],
    },
  ]);
});

test("0072 takes a plugin's existing skill files as the plugin's own, and none of the owner's", async () => {
  const { cp, mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "dispand-0072-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const before = join(dir, "migrations");
  await cp(new URL("../../drizzle", import.meta.url).pathname, before, { recursive: true });
  const journalPath = join(before, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((e) => e.tag < "0072");
  await writeFile(journalPath, JSON.stringify(journal));
  const url = `pglite://${join(dir, "db")}`;
  const old = await createDb(url, before);
  await old.execute(sql`insert into "user" (id, name, email) values ('user_1', 'Ada', 'ada@example.com')`);
  await old.execute(sql`insert into plugins (id, owner_id, name, description, components) values ('plugin_1', 'user_1', 'kit', '', '{"skills":[],"mcpServers":[],"agents":[]}')`);
  await old.execute(sql`insert into skill_packages (id, owner_id, name, description, plugin_id) values ('pkg_p', 'user_1', 'kit', '', 'plugin_1'), ('pkg_o', 'user_1', 'mine', '', null)`);
  await old.execute(sql`insert into skill_files (package_id, path, content) values ('pkg_p', 'a/SKILL.md', 'plugin'::bytea), ('pkg_o', 'mine/SKILL.md', 'mine'::bytea)`);
  await closeDb(old);
  const db = await createDb(url);
  onTestFinished(() => closeDb(db));
  expect(rowsOf(await db.execute(sql`select package_id, path, convert_from(content, 'UTF8') as text from skill_file_upstream`))).toEqual([{ package_id: "pkg_p", path: "a/SKILL.md", text: "plugin" }]);
});

test("0091 gives the existing owner a workspace and preserves their job, file and paired runner", async () => {
  const { cp, mkdir, mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "dispand-0091-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const before = join(dir, "migrations");
  await cp(new URL("../../drizzle", import.meta.url).pathname, before, { recursive: true });
  const journalPath = join(before, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { tag: string }[] };
  const beforeRunnerPlacement = journal.entries.filter((entry) => entry.tag < "0095");
  await writeFile(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.tag < "0091") }));
  const url = `pglite://${join(dir, "db")}`;
  const old = await createDb(url, before);
  await old.execute(sql`insert into "user" (id, name, email) values ('u', 'Ada', 'ada@example.com')`);
  await old.execute(sql`insert into workflows (id, owner_id, name, current_version) values ('w', 'u', 'Workflow', 1)`);
  await old.execute(sql`insert into runs (id, owner_id, workflow_id, version, status) values ('j', 'u', 'w', 1, 'succeeded')`);
  await old.execute(sql`insert into attachments (id, owner_id, job_id, name, mime, size, image)
    values ('a', 'u', 'j', 'result.txt', 'application/octet-stream', 8, false)`);
  await mkdir(join(dir, "files", "u"), { recursive: true });
  await writeFile(join(dir, "files", "u", "a"), "preserve");
  const { findRunnerByToken } = await import("../runners/pairing.ts");
  const { createHash } = await import("node:crypto");
  // 0091 gave each existing user their own workspace.
  await old.execute(sql`insert into "user" (id, name, email) values ('other', 'Other', 'other@example.com')`);
  const code = "OLDPAIR1";
  await old.execute(sql`insert into runners (id, owner_id, name) values ('r', 'u', 'Machine')`);
  await old.execute(sql`insert into runner_pairings (id, owner_id, runner_id, code_hash, expires_at)
    values ('p', 'u', 'r', ${createHash("sha256").update(code).digest("hex")}, now() + interval '15 minutes')`);
  await old.execute(sql`insert into step_runs (id, owner_id, run_id, runner_id, node_id, status) values ('s', 'u', 'j', 'r', 'n', 'succeeded')`);
  // Paired before 0091 (today's `pair` reads workspaces, which don't exist yet): its token's hash, as pairing stored it.
  const paired = { runnerId: "r", token: "pre-workspace-paired-token" };
  await old.execute(sql`update runner_pairings set used_at = now() where id = 'p'`);
  await old.execute(sql`update runners set token_hash = ${createHash("sha256").update(paired.token).digest("hex")} where id = 'r'`);
  await closeDb(old);

  await writeFile(journalPath, JSON.stringify({ ...journal, entries: beforeRunnerPlacement }));
  const beforePlacement = await createDb(url, before);
  // A new organization membership must not move the runner away from its existing jobs.
  await beforePlacement.execute(sql`insert into organization_members (organization_id, user_id, role) values ('org_other', 'u', 'owner')`);
  // A configured runner can have completed work in a former workspace.
  await beforePlacement.execute(sql`insert into runners (id, owner_id, name) values ('configured', 'u', 'Laptop')`);
  await beforePlacement.execute(sql`insert into harnesses (id, owner_id, name, runner_id, kind) values ('h', 'u', 'CLI', 'configured', 'codex')`);
  await beforePlacement.execute(sql`insert into agents (id, workspace_id, owner_id, name, harness_id, system_prompt) values ('agent', 'ws_other', 'u', 'Current agent', 'h', '')`);
  await beforePlacement.execute(sql`insert into step_runs (id, owner_id, run_id, runner_id, node_id, status) values ('s2', 'u', 'j', 'configured', 'n2', 'succeeded')`);
  const unusedToken = "pre-workspace-unused-token";
  await beforePlacement.execute(sql`insert into runners (id, owner_id, name, token_hash) values ('ambiguous', 'u', 'Unused', ${createHash("sha256").update(unusedToken).digest("hex")})`);
  await closeDb(beforePlacement);
  await expect(createDb(url)).rejects.toMatchObject({ cause: { message: expect.stringContaining("ambiguous, configured") } });
  const choose = await createDb(url, before);
  expect(rowsOf(await choose.execute(sql`select column_name from information_schema.columns where table_name = 'runners' and column_name = 'workspace_id'`))).toEqual([]);
  await choose.execute(sql`create table dispand_runner_workspace_assignments (runner_id text primary key references runners(id), workspace_id text not null references workspaces(id))`);
  await choose.execute(sql`insert into dispand_runner_workspace_assignments values ('ambiguous', 'ws_u'), ('configured', 'ws_other')`);
  // An operator choice that would displace a live session also rolls back.
  await choose.execute(sql`update runs set status = 'running' where id = 'j'`);
  await choose.execute(sql`update step_runs set status = 'running' where id = 's2'`);
  await closeDb(choose);
  await expect(createDb(url)).rejects.toMatchObject({ cause: { message: expect.stringContaining("upgrading: configured") } });
  const previous = await createDb(url, before);
  expect(rowsOf(await previous.execute(sql`select status from step_runs where id = 's2'`))).toEqual([{ status: "running" }]);
  await previous.execute(sql`update step_runs set status = 'succeeded' where id = 's2'`);
  await previous.execute(sql`update runs set status = 'succeeded' where id = 'j'`);
  await closeDb(previous);

  const db = await createDb(url);
  onTestFinished(() => closeDb(db));
  expect(rowsOf(await db.execute(sql`select m.user_id, m.role, w.id as workspace_id, w.name as workspace_name, o.name as organization_name from organization_members m
    join workspaces w using (organization_id) join organizations o on o.id = w.organization_id order by m.user_id, w.id`))).toEqual([
    { user_id: "other", role: "owner", workspace_id: "ws_other", workspace_name: "Main workspace", organization_name: "My organization" },
    { user_id: "u", role: "owner", workspace_id: "ws_other", workspace_name: "Main workspace", organization_name: "My organization" },
    { user_id: "u", role: "owner", workspace_id: "ws_u", workspace_name: "Main workspace", organization_name: "My organization" },
  ]);
  expect(rowsOf(await db.execute(sql`select j.id, a.id as file from runs j
    join workflows f on f.id = j.workflow_id and f.workspace_id = j.workspace_id
    join workspaces w on w.id = j.workspace_id
    join organization_members m on m.organization_id = w.organization_id and m.user_id = j.owner_id
    join attachments a on a.job_id = j.id and a.owner_id = j.owner_id where j.owner_id = 'u'`))).toEqual([{ id: "j", file: "a" }]);
  expect(rowsOf(await db.execute(sql`select workspace_id from runners where id = 'configured'`))).toEqual([{ workspace_id: "ws_other" }]);
  expect(await findRunnerByToken(db, unusedToken)).toMatchObject({ id: "ambiguous", workspaceId: "ws_u" });
  await expect(db.execute(sql`insert into runners (id, owner_id, name) values ('unplaced', 'u', 'Missing workspace')`)).rejects.toThrow();
  expect(await findRunnerByToken(db, paired.token)).toMatchObject({ id: paired.runnerId, ownerId: "u", workspaceId: "ws_u" });
  const { openAttachment } = await import("../data/files.ts");
  const file = await openAttachment(db, join(dir, "files"), "u", "a");
  expect(await new Response(file?.body).text()).toBe("preserve");
});
