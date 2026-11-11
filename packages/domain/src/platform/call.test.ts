import { call } from "@orpc/server";
import { expect, test } from "vitest";
import { account, user } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import type { Bundle, TableScope } from "./bundles.ts";
import { callPlatformTool, toolsOf, type JobIdentity } from "./call.ts";

/** An agent with `bundles` on `tables` (t1 by default), two tables with a row each, and a Job of the agent still going. */
async function setup(bundles: Bundle[] = ["data"], scope: (t1: string, t2: string) => TableScope = (t1) => [t1]) {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const t1 = await call(router.tables.create, { name: "Clients" }, { context });
  const t2 = await call(router.tables.create, { name: "Matters" }, { context });
  // A new table comes with its first field.
  const name = (await call(router.tables.get, { id: t1.id }, { context })).fields[0]!;
  const r1 = await call(router.rows.create, { tableId: t1.id, values: { [name.id]: "Ada" } }, { context });
  const r2 = await call(router.rows.create, { tableId: t2.id }, { context });
  const base = { name: "Clerk", harnessId: harness.id, systemPrompt: "" };
  const agent = await call(router.agents.create, { ...base, bundles, dataTables: scope(t1.id, t2.id) }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
  const job: JobIdentity = { runId, ownerId: context.ownerId, agentId: agent.id };
  const tool = (toolName: string, input: unknown = {}) => callPlatformTool(context, job, toolName, input);
  const setAgent = (patch: { bundles?: Bundle[]; dataTables?: TableScope }) => call(router.agents.update, { ...base, id: agent.id, ...patch }, { context });
  return { context, agent, trigger, job, t1, t2, r1, r2, name, tool, setAgent };
}

const notFound = { ok: false, error: "Not found" };

test("a data Job lists, reads, creates, updates and deletes rows of its table", async () => {
  const { context, t1, r1, name, tool } = await setup();
  expect(await tool("rows_list", { tableId: t1.id })).toMatchObject({ ok: true, output: { rows: [{ id: r1.id }] } });
  expect(await tool("rows_get", { id: r1.id })).toMatchObject({ ok: true, output: { id: r1.id, values: { [name.id]: "Ada" } } });
  const created = await tool("rows_create", { tableId: t1.id, values: { [name.id]: "Grace" } });
  expect(created).toMatchObject({ ok: true, output: { values: { [name.id]: "Grace" } } });
  const id = (created as { output: { id: string } }).output.id;
  expect(await tool("rows_update", { id, values: { [name.id]: "Grace H." } })).toMatchObject({ ok: true });
  expect(await call(router.rows.get, { id }, { context })).toMatchObject({ values: { [name.id]: "Grace H." } });
  expect(await tool("rows_delete", { ids: [id] })).toMatchObject({ ok: true });
  await expect(call(router.rows.get, { id }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await tool("tables_get", { id: t1.id })).toMatchObject({ ok: true, output: { id: t1.id, fields: [{ id: name.id }] } });
});

test("tables_list shows only the Job's tables", async () => {
  const { t1, tool } = await setup();
  expect(await tool("tables_list")).toMatchObject({ ok: true, output: [{ id: t1.id }] });
  expect(((await tool("tables_list")) as { output: unknown[] }).output).toHaveLength(1);
  const all = await setup(["data"], () => "all");
  expect(((await all.tool("tables_list")) as { output: unknown[] }).output).toHaveLength(2);
});

test("a table outside the Job's tables is refused like a missing one", async () => {
  const { context, t2, r1, r2, tool } = await setup();
  expect(await tool("rows_list", { tableId: t2.id })).toEqual(notFound);
  expect(await tool("rows_list", { tableId: "table_nobody" })).toEqual(notFound);
  expect(await tool("rows_create", { tableId: t2.id })).toEqual(notFound);
  expect(await tool("rows_get", { id: r2.id })).toEqual(notFound);
  expect(await tool("rows_get", { id: "row_nobody" })).toEqual(notFound);
  expect(await tool("rows_update", { id: r2.id, values: {} })).toEqual(notFound);
  expect(await tool("tables_get", { id: t2.id })).toEqual(notFound);
  // One row out of scope refuses the whole call: nothing is deleted.
  expect(await tool("rows_delete", { ids: [r1.id, r2.id] })).toEqual(notFound);
  expect(await call(router.rows.get, { id: r1.id }, { context })).toMatchObject({ id: r1.id });
  expect(await call(router.rows.get, { id: r2.id }, { context })).toMatchObject({ id: r2.id });
});

test("another owner's row is refused the same way", async () => {
  const { context, tool } = await setup(["data"], () => "all");
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  const ctx = await context.auth.$context;
  await context.db.insert(account).values({ id: "acct_other", accountId: "user_other", providerId: "credential", userId: "user_other", password: await ctx.password.hash("eve's password") });
  const res = await context.auth.api.signInEmail({ body: { email: "eve@example.com", password: "eve's password" }, returnHeaders: true });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const eve = { ...context, headers: new Headers({ cookie }) };
  const table = await call(router.tables.create, { name: "Eve's" }, { context: eve });
  const row = await call(router.rows.create, { tableId: table.id }, { context: eve });
  expect(await tool("rows_get", { id: row.id })).toEqual(notFound);
  expect(await tool("rows_list", { tableId: table.id })).toEqual(notFound);
  expect(await tool("rows_delete", { ids: [row.id] })).toEqual(notFound);
  expect(await call(router.rows.get, { id: row.id }, { context: eve })).toMatchObject({ id: row.id });
});

test("a tool of a bundle the Job doesn't have is refused", async () => {
  const { context, tool, job } = await setup();
  expect(await tool("tables_create", { name: "New" })).toEqual({ ok: false, error: "This agent may not use tables_create" });
  expect((await toolsOf(context.db, job)).map((t) => t.name).sort()).toEqual(["rows_create", "rows_delete", "rows_get", "rows_list", "rows_update", "tables_get", "tables_list"]);
});

test("a bundle or a table removed from the agent applies to its running Job", async () => {
  const { context, job, t1, t2, r1, tool, setAgent } = await setup(["data"], () => "all");
  expect(await tool("rows_list", { tableId: t2.id })).toMatchObject({ ok: true });
  await setAgent({ dataTables: [t1.id] });
  expect(await tool("rows_list", { tableId: t2.id })).toEqual(notFound);
  expect(await tool("rows_get", { id: r1.id })).toMatchObject({ ok: true });
  expect(((await tool("tables_list")) as { output: unknown[] }).output).toHaveLength(1);
  await setAgent({ dataTables: [] });
  expect(await tool("rows_get", { id: r1.id })).toEqual(notFound);
  await setAgent({ bundles: [], dataTables: "all" });
  expect(await tool("rows_get", { id: r1.id })).toEqual({ ok: false, error: "This agent may not use rows_get" });
  expect(await toolsOf(context.db, job)).toEqual([]);
});

test("a bundle or a table added to the agent after the Job was created is not the Job's", async () => {
  const { t2, tool, setAgent } = await setup();
  await setAgent({ bundles: ["data", "configure"], dataTables: "all" });
  expect(await tool("tables_create", { name: "New" })).toEqual({ ok: false, error: "This agent may not use tables_create" });
  expect(await tool("rows_list", { tableId: t2.id })).toEqual(notFound);
});

test("a Job that is over calls nothing", async () => {
  const { context, job, r1, tool } = await setup();
  await context.engine.stopRun(job.runId);
  expect(await tool("rows_get", { id: r1.id })).toEqual({ ok: false, error: "This Job is over" });
  expect(await toolsOf(context.db, job)).toEqual([]);
});

test("an identity that doesn't match its run calls nothing", async () => {
  const { context, job, r1 } = await setup();
  for (const wrong of [{ ...job, runId: "run_nobody" }, { ...job, ownerId: "user_nobody" }, { ...job, agentId: "agent_nobody" }]) {
    expect(await callPlatformTool(context, wrong, "rows_get", { id: r1.id })).toEqual({ ok: false, error: "This Job is over" });
  }
});

test("invalid input is refused with the schema's message, and an unknown tool by name", async () => {
  const { t1, tool } = await setup();
  const bad = await tool("rows_list", { tableId: t1.id, limit: -1 });
  expect(bad).toMatchObject({ ok: false });
  expect((bad as { error: string }).error).toMatch(/limit/);
  expect(await tool("rows_stream", { tableIds: [t1.id] })).toEqual({ ok: false, error: "Unknown tool" });
  expect(await tool("agents_delete", {})).toEqual({ ok: false, error: "Unknown tool" });
  // Changing an agent is a `configure` tool (and needs a proposal): not this Job's.
  expect(await tool("agents_update", {})).toEqual({ ok: false, error: "This agent may not use agents_update" });
});

test("a configure Job creates a table and a field, and can't delete either on its own", async () => {
  const { context, t1, name, tool } = await setup(["data", "configure"], () => "all");
  const created = await tool("tables_create", { name: "Invoices" });
  expect(created).toMatchObject({ ok: true, output: { name: "Invoices" } });
  const tableId = (created as { output: { id: string } }).output.id;
  expect(await tool("fields_create", { tableId, name: "Amount", type: "number" })).toMatchObject({ ok: true });
  expect(await tool("rows_create", { tableId })).toMatchObject({ ok: true });
  expect(await tool("fields_update", { id: name.id, name: "Full name" })).toMatchObject({ ok: true });
  expect(await tool("tables_rename", { id: t1.id, name: "People" })).toMatchObject({ ok: true });
  // Deleting takes a proposal a person approved; changing a field's type is not a tool at all.
  for (const [toolName, input] of [["tables_delete", { id: tableId }], ["fields_delete", { id: name.id }]] as const) {
    expect(((await tool(toolName, input)) as { error: string }).error).toMatch(/needs the owner's approval/);
  }
  expect(await tool("fields_retype", { id: name.id, type: "number", dryRun: false })).toEqual({ ok: false, error: "Unknown tool" });
  expect((await call(router.tables.list, undefined, { context })).map((t) => t.name).sort()).toEqual(["Invoices", "Matters", "People"]);
});

test("a procedure's own refusal comes back as its message, and a crash as a plain failure", async () => {
  const { context, job, t1, tool } = await setup(["data", "configure"], () => "all");
  // A second table of the same name: the procedure's own error.
  const dup = await tool("tables_create", { name: "clients" });
  expect(dup).toMatchObject({ ok: false });
  expect((dup as { error: string }).error).not.toBe("The tool failed");
  const broken = { ...context, db: { ...context.db, select: context.db.select.bind(context.db), transaction: () => Promise.reject(new Error("secret internals: connection string")) } } as unknown as typeof context;
  const failed = await callPlatformTool(broken, job, "rows_create", { tableId: t1.id });
  expect(failed).toEqual({ ok: false, error: "The tool failed" });
});

test("the session cookie path is unchanged: without a job, authed still needs a session", async () => {
  const { context } = await setup();
  await expect(call(router.tables.list, undefined, { context: { ...context, headers: new Headers() } })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("a Job can add or relabel a field's choices, never remove one: removing clears the rows that use it", async () => {
  const { context, t1, r1, tool } = await setup(["configure"], () => "all");
  const choices = [{ id: "open", label: "Open" }, { id: "closed", label: "Closed" }];
  const status = await call(router.fields.create, { tableId: t1.id, name: "Status", type: "single-select", choices }, { context });
  await call(router.rows.update, { id: r1.id, values: { [status.id]: "closed" } }, { context });

  const refusal = { ok: false, error: "Removing a choice clears the rows that use it: only the owner does that" };
  expect(await tool("fields_update", { id: status.id, choices: [choices[0]] })).toEqual(refusal);
  expect(await tool("fields_update", { id: status.id, choices: [] })).toEqual(refusal);
  expect(await call(router.rows.get, { id: r1.id }, { context })).toMatchObject({ values: { [status.id]: "closed" } });
  // Adding one and relabelling another keep every row as it is.
  expect(await tool("fields_update", { id: status.id, choices: [{ id: "open", label: "To do" }, choices[1], { id: "late", label: "Late" }] })).toMatchObject({ ok: true });
  expect(await call(router.rows.get, { id: r1.id }, { context })).toMatchObject({ values: { [status.id]: "closed" } });
  // The owner still can.
  await call(router.fields.update, { id: status.id, choices: [choices[0]!] }, { context });
  expect((await call(router.rows.get, { id: r1.id }, { context })).values[status.id]).toBeNull();
});

test("a reference field a Job adds names a table within its tables only", async () => {
  const { t1, t2, tool } = await setup(["data", "configure"], (t1) => [t1]);
  expect(await tool("fields_create", { tableId: t1.id, name: "Matter", type: "reference", referencesTableId: t2.id })).toEqual(notFound);
  expect(await tool("fields_create", { tableId: t1.id, name: "Parent", type: "reference", referencesTableId: t1.id })).toMatchObject({ ok: true });
});

test("a Job sees reference labels only from its own tables, and can't delete a row whose references live in a table it can't write", async () => {
  const { context, t1, t2, r1, tool } = await setup(["data", "configure"], (t1) => [t1]);
  // t2's rows name t1's rows; t1's rows name t2's rows.
  const toT1 = await call(router.fields.create, { tableId: t2.id, name: "Client", type: "reference", referencesTableId: t1.id }, { context });
  const toT2 = await call(router.fields.create, { tableId: t1.id, name: "Matter", type: "reference", referencesTableId: t2.id }, { context });
  const matter = await call(router.rows.create, { tableId: t2.id, values: { [toT1.id]: r1.id } }, { context });
  await call(router.rows.update, { id: r1.id, values: { [toT2.id]: matter.id } }, { context });
  // r1 names a row of t2, which the Job can't read: its label isn't given.
  expect(await tool("rows_get", { id: r1.id })).toMatchObject({ ok: true, output: { references: {} } });
  expect(((await tool("rows_list", { tableId: t1.id })) as { output: { references: object } }).output.references).toEqual({});
  // Deleting r1 would clear a cell of t2: refused, and nothing changes.
  expect(await tool("rows_delete", { ids: [r1.id] })).toEqual(notFound);
  expect((await call(router.rows.get, { id: matter.id }, { context })).values[toT1.id]).toBe(r1.id);
});
