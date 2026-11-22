import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrateDb, type Db } from "./client.ts";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** The schema `seedPreUpgrade` writes for: migrate to it, seed, then run the migrations after it. */
export const PRE_UPGRADE_TAG = "0095_runner_workspace";

/**
 * Applies the migrations up to and including `tag`, so an upgrade test seeds the database as it
 * was before a migration, then runs the rest with `migrateDb`.
 */
export async function migrateTo(db: Db, tag: string): Promise<void> {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const end = journal.entries.findIndex((entry) => entry.tag === tag);
  if (end < 0) throw new Error(`no migration tagged ${tag}`);
  const folder = await mkdtemp(join(tmpdir(), "dispand-migrations-"));
  try {
    await mkdir(join(folder, "meta"));
    const entries = journal.entries.slice(0, end + 1);
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    for (const { tag } of entries) await copyFile(join(migrationsFolder, `${tag}.sql`), join(folder, `${tag}.sql`));
    await migrateDb(db, folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** The tables `seedPreUpgrade` writes rows to: an upgrade must keep every one of them. */
export const SEEDED_TABLES = [
  "user", "organizations", "organization_members", "workspaces", "workspace_members", "runners", "harnesses", "tools",
  "skill_packages", "agents", "agent_skills", "agent_tools", "triggers", "tables", "attachments",
] as const;

export type PreUpgrade = {
  organizationId: string;
  workspaceId: string;
  owner: string;
  invitee: string;
  removedInvitee: string;
  managerRunnerId: string;
  cliHarnessId: string;
  cloudHarnessId: string;
  oauthToolId: string;
  /** The owner's Assistant, then its chat and review triggers (it is also linked to the owner's built-in skills and the OAuth tool). */
  assistantLinkIds: string[];
  attachmentIds: string[];
};

/**
 * Fills a database at `PRE_UPGRADE_TAG` with the rows an install in use has, as the code writes
 * them: the organization's owner (no workspace membership row); an invitee managing the workspace;
 * a removed invitee, who keeps the organization membership and owns a revoked runner; everyone's
 * built-in skill package (the startup sync writes one per user); a runner the manager registered,
 * with the owner's CLI harness on it, and the owner's cloud harness; an OAuth tool; the owner's
 * Assistant with its skill, tool and triggers; attachments with their files under
 * `<filesDir>/<owner_id>/<id>`. Plain SQL, no domain helpers, so later code changes don't change
 * what it writes.
 */
export async function seedPreUpgrade(db: Db, filesDir: string): Promise<PreUpgrade> {
  const s: PreUpgrade = {
    organizationId: "org-1",
    workspaceId: "ws-1",
    owner: "user-owner",
    invitee: "user-invitee",
    removedInvitee: "user-removed",
    managerRunnerId: "runner-manager",
    cliHarnessId: "harness-cli",
    cloudHarnessId: "harness-cloud",
    oauthToolId: "tool-oauth",
    assistantLinkIds: ["agent-assistant", "trigger-chat", "trigger-review"],
    attachmentIds: ["attachment-table", "attachment-loose"],
  };
  const [assistant, chat, review] = s.assistantLinkIds as [string, string, string];
  await db.execute(sql`insert into "user" (id, name, email) values
    (${s.owner}, 'Owner', 'owner@example.com'),
    (${s.invitee}, 'Invitee', 'invitee@example.com'),
    (${s.removedInvitee}, 'Removed', 'removed@example.com')`);
  await db.execute(sql`insert into organizations (id) values (${s.organizationId})`);
  await db.execute(sql`insert into organization_members (organization_id, user_id, role) values
    (${s.organizationId}, ${s.owner}, 'owner'), (${s.organizationId}, ${s.invitee}, 'member'), (${s.organizationId}, ${s.removedInvitee}, 'member')`);
  await db.execute(sql`insert into workspaces (id, organization_id) values (${s.workspaceId}, ${s.organizationId})`);
  await db.execute(sql`insert into workspace_members (workspace_id, user_id, role) values (${s.workspaceId}, ${s.invitee}, 'manager')`);
  await db.execute(sql`insert into runners (id, workspace_id, owner_id, name, token_hash, clis) values
    (${s.managerRunnerId}, ${s.workspaceId}, ${s.invitee}, 'build box', 'runner-token-hash', '{"claude":"2.0.0"}')`);
  await db.execute(sql`insert into runners (id, workspace_id, owner_id, name, revoked_at) values
    ('runner-removed', ${s.workspaceId}, ${s.removedInvitee}, 'old box', now())`);
  await db.execute(sql`insert into harnesses (id, owner_id, name, type, runner_id, kind, permission_mode) values
    (${s.cliHarnessId}, ${s.owner}, 'Claude Code', 'cli', ${s.managerRunnerId}, 'claude-code', 'default')`);
  await db.execute(sql`insert into harnesses (id, owner_id, name, type, kind, model, api_key_sealed) values
    (${s.cloudHarnessId}, ${s.owner}, 'Cloud', 'cloud', 'anthropic', 'claude-sonnet', 'sealed-key')`);
  await db.execute(sql`insert into tools (id, owner_id, name, kind, url, transport, auth, oauth_sealed, oauth_status) values
    (${s.oauthToolId}, ${s.owner}, 'Calendar', 'http', 'https://mcp.example.com/mcp', 'streamable-http', 'oauth', 'sealed-oauth', 'connected')`);
  await db.execute(sql`insert into skill_packages (id, owner_id, name, description, built_in) values
    ('skills-owner', ${s.owner}, 'dispand', 'Built-in skills', true),
    ('skills-invitee', ${s.invitee}, 'dispand', 'Built-in skills', true),
    ('skills-removed', ${s.removedInvitee}, 'dispand', 'Built-in skills', true)`);
  await db.execute(sql`insert into agents (id, workspace_id, owner_id, name, harness_id, system_prompt, bundles, data_tables, self_learning, built_in) values
    (${assistant}, ${s.workspaceId}, ${s.owner}, 'Assistant', ${s.cliHarnessId}, '', '["data","configure"]', '"all"', '["workspace"]', 'assistant')`);
  await db.execute(sql`insert into agent_skills (agent_id, package_id) values (${assistant}, 'skills-owner')`);
  await db.execute(sql`insert into agent_tools (agent_id, tool_id) values (${assistant}, ${s.oauthToolId})`);
  await db.execute(sql`insert into triggers (id, owner_id, agent_id, kind, name, config, enabled, built_in) values
    (${chat}, ${s.owner}, ${assistant}, 'manual', 'Chat', '{"kind":"manual","placement":"chat"}', true, null),
    (${review}, ${s.owner}, ${assistant}, 'schedule', 'Review the workspace', '{"kind":"schedule","cron":"0 9 * * 1","timezone":"UTC"}', false, 'review')`);
  await db.execute(sql`insert into tables (id, owner_id, name) values ('table-1', ${s.owner}, 'Contacts')`);
  // The loose one is a Job's file whose Job is gone (`job_id` set null): no table, no Job.
  const [inTable, loose] = s.attachmentIds as [string, string];
  await db.execute(sql`insert into attachments (id, owner_id, table_id, name, mime, size, image) values
    (${inTable}, ${s.owner}, 'table-1', 'notes.txt', 'application/octet-stream', 5, false),
    (${loose}, ${s.owner}, null, 'report.txt', 'application/octet-stream', 5, false)`);
  await mkdir(join(filesDir, s.owner), { recursive: true });
  for (const id of s.attachmentIds) await writeFile(join(filesDir, s.owner, id), "hello");
  return s;
}
