import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { testDb } from "../runners/test-support.ts";

// A foreign key says a row exists, not that it is of the same workspace: two rows of different
// workspaces can name each other. Every foreign key between workspace rows is listed here with
// what keeps both ends in one workspace:
// - child: the row has no workspace of its own and this key names the row it belongs to;
// - written: the row takes its workspace, or the id, from the row it names when it is written;
// - checked: the code that matches the two workspaces, at the write or at each use;
// - one workspace: written only by procedures that admit the install's one workspace, until they
//   are gated by workspace role.
// A new key fails until it is listed, and a listed key that is gone fails too.

type Kind = "child" | "written" | "checked" | "one workspace";
/** "table.column → parent": [kind, where]. */
const LISTED: Record<string, [Kind, string]> = {
  "agent_consults.agent_id → agents": ["child", "the agent's list"],
  "agent_consults.consulted_id → agents": ["checked", "pairProblem"],
  "agent_skill_tool_permissions.agent_id → agents": ["child", "the agent's choices"],
  "agent_skill_tool_permissions.skill_package_id → skill_packages": ["checked", "packagesRequiring"],
  "agent_skill_tool_permissions.tool_id → tools": ["checked", "writeSkillPermission"],
  "agent_skills.agent_id → agents": ["child", "the agent's packages"],
  "agent_skills.package_id → skill_packages": ["checked", "skillsAndTools"],
  "agent_tools.agent_id → agents": ["child", "the agent's tools"],
  "agent_tools.tool_id → tools": ["checked", "toolingOf"],
  "agents.harness_id → harnesses": ["checked", "sessionHarness"],
  "agents.plugin_id → plugins": ["one workspace", "plugins/setup.ts"],
  "artifacts.message_id → messages": ["written", "artifacts/show.ts: the Job's own message"],
  "artifacts.run_id → runs": ["child", "the Job's artifacts"],
  "artifacts.step_run_id → step_runs": ["written", "artifacts/show.ts: the Job's own step"],
  "attachments.job_id → runs": ["written", "keepJobFiles: the run's workspace"],
  "attachments.table_id → tables": ["checked", "lockAttachments"],
  "chat_queue.run_id → runs": ["child", "the run's queue"],
  "chat_queue.step_run_id → step_runs": ["written", "Engine.sendChat: the run's chat step"],
  "cloud_sessions.step_run_id → step_runs": ["child", "the step's session"],
  "event_fires.event_id → events": ["checked", "Scheduler: events of the trigger's agent's workspace"],
  "event_fires.run_id → runs": ["written", "Engine.createJob: the trigger's agent's workspace"],
  "event_fires.trigger_id → triggers": ["child", "the trigger's fires"],
  "events.root_id → roots": ["written", "recordJobEvent: the run's root and workspace"],
  "fields.references_table_id → tables": ["checked", "writeRow: a referenced row's table"],
  "fields.table_id → tables": ["child", "the table's fields"],
  "harnesses.runner_id → runners": ["checked", "sessionHarness"],
  "memories.agent_id → agents": ["checked", "scopeExists"],
  "memories.table_id → tables": ["checked", "scopeExists"],
  "memory_revisions.memory_id → memories": ["child", "the entry's revisions"],
  "messages.run_id → runs": ["child", "the run's transcript"],
  "messages.step_run_id → step_runs": ["written", "the run's own step"],
  "plugin_conflicts.plugin_id → plugins": ["child", "the plugin's conflicts"],
  "plugin_conflicts.run_id → runs": ["written", "handToStem: the Stem Job it makes"],
  "plugin_files.plugin_id → plugins": ["child", "the plugin's files"],
  "plugins.marketplace_id → marketplaces": ["one workspace", "plugins/procedures.ts"],
  "poll_items.run_id → runs": ["written", "Engine.createJob: the trigger's agent's workspace"],
  "poll_items.trigger_id → triggers": ["child", "the trigger's items"],
  "polls.trigger_id → triggers": ["child", "the trigger's polls"],
  "proposals.run_id → runs": ["child", "the Job's proposals"],
  "questions.addressee_agent_id → agents": ["checked", "pairProblem, before a consult opens"],
  "questions.consult_run_id → runs": ["written", "Engine.createJob: the asking run's root"],
  "questions.root_id → roots": ["written", "the run's root"],
  "questions.run_id → runs": ["child", "the run's questions"],
  "questions.step_run_id → step_runs": ["written", "the run's own step"],
  "rows.table_id → tables": ["child", "the table's rows"],
  "runner_pairings.runner_id → runners": ["child", "the runner's pairing"],
  "runs.agent_id → agents": ["written", "Engine.createJob: the agent's workspace"],
  "runs.root_id → roots": ["checked", "Engine.createJob"],
  "runs.trigger_id → triggers": ["written", "Engine.createJob: the trigger of its agent"],
  "runs.workflow_id → workflows": ["written", "Engine.createRun: the workflow's workspace"],
  "schedule_fires.run_id → runs": ["written", "Engine.createRun: the workflow's workspace"],
  "schedule_fires.workflow_id → workflows": ["child", "the workflow's fires"],
  "schedules.workflow_id → workflows": ["child", "the workflow's schedule"],
  "skill_file_upstream.package_id → skill_packages": ["child", "the package's files"],
  "skill_files.package_id → skill_packages": ["child", "the package's files"],
  "skill_packages.plugin_id → plugins": ["one workspace", "plugins/setup.ts"],
  "skills.package_id → skill_packages": ["child", "the package's skills"],
  "step_runs.harness_id → harnesses": ["checked", "agentHarnesses, sessionHarness"],
  "step_runs.run_id → runs": ["child", "the run's steps"],
  "tables.parent_field_id → fields": ["written", "a field of the table itself"],
  "tables.plugin_id → plugins": ["one workspace", "plugins/setup.ts"],
  "tools.plugin_id → plugins": ["one workspace", "plugins/setup.ts"],
  "tools.runner_id → runners": ["checked", "runnerServers: only the session's runner"],
  "trigger_fires.run_id → runs": ["written", "Engine.createJob: the trigger's agent's workspace"],
  "trigger_fires.trigger_id → triggers": ["child", "the trigger's fires"],
  "triggers.agent_id → agents": ["child", "the agent's triggers"],
  "triggers.plugin_id → plugins": ["one workspace", "plugins/setup.ts"],
  "widgets.page_id → pages": ["child", "the page's widgets"],
  "widgets.table_id → tables": ["checked", "checkConfig (pages)"],
  "widgets.trigger_id → triggers": ["one workspace", "pages/procedures.ts"],
  "widgets.workflow_id → workflows": ["one workspace", "pages/procedures.ts"],
  "workflow_versions.workflow_id → workflows": ["child", "the workflow's versions"],
};

// Not workspace rows: people, organizations, workspaces themselves, and a person's devices.
const OUTSIDE = new Set(["user", "account", "session", "verification", "organizations", "organization_members", "workspaces", "push_subscriptions", "push_deliveries", "push_keys"]);

test("every foreign key between workspace tables is listed with what keeps it in one workspace", async () => {
  const db = await testDb();
  const result = await db.execute(sql`
    select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent,
      (select string_agg(a.attname, ',') from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any(c.conkey)) as cols
    from pg_constraint c where c.contype = 'f'`);
  const { rows } = result as unknown as { rows: { child: string; parent: string; cols: string }[] };
  const keys = rows
    .map((r) => ({ child: r.child.replaceAll('"', ""), parent: r.parent.replaceAll('"', ""), cols: r.cols }))
    .filter((r) => !OUTSIDE.has(r.child) && !OUTSIDE.has(r.parent))
    .map((r) => `${r.child}.${r.cols} → ${r.parent}`)
    .sort();
  expect(keys.filter((k) => !(k in LISTED))).toEqual([]);
  expect(Object.keys(LISTED).filter((k) => !keys.includes(k))).toEqual([]);
});
