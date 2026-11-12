import { call } from "@orpc/server";
import { eq, sql } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { audit, proposals } from "../db/schema.ts";
import { ALL_TOOLS, callPlatformTool, type JobIdentity } from "../platform/call.ts";
import type { Bundle, TableScope } from "../platform/bundles.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { AUDIT_RESOURCES } from "./model.ts";
import { recordAudit } from "./record.ts";
import { auditResource, RESOURCE_OF, resourceKey } from "./resource.ts";

/** Sentinel content an agent might write as an id: it must never reach a row. */
const SENTINEL = "zzz-sentinel-row-value";

/** An agent with `bundles` on `scope`, two tables with a row each, and a Job of it still going. */
async function setup(bundles: Bundle[] = ["data"], scope: (t1: string, t2: string) => TableScope = (t1) => [t1]) {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const t1 = await call(router.tables.create, { name: "Clients" }, { context });
  const t2 = await call(router.tables.create, { name: "Matters" }, { context });
  const r1 = await call(router.rows.create, { tableId: t1.id }, { context });
  const r2 = await call(router.rows.create, { tableId: t2.id }, { context });
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "", bundles, dataTables: scope(t1.id, t2.id) }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
  const job: JobIdentity = { runId, ownerId: context.ownerId, agentId: agent.id };
  const tool = (name: string, input: unknown = {}) => callPlatformTool(context, job, name, input);
  /** The Job's `platform.call` rows, oldest first. */
  const calls = async () =>
    (await context.db.select().from(audit).where(eq(audit.jobId, runId)).orderBy(audit.at, audit.id)).filter((r) => r.action === "platform.call");
  const last = async () => (await calls()).at(-1)!;
  return { context, agent, job, t1, t2, r1, r2, tool, calls, last };
}

test("a read and a write each leave one row with their table, the Job and ok", async () => {
  const { t1, r1, job, tool, calls } = await setup();
  expect(await tool("rows_list", { tableId: t1.id })).toMatchObject({ ok: true });
  const created = await tool("rows_create", { tableId: t1.id });
  const rowId = (created as { output: { id: string } }).output.id;
  expect(await tool("rows_get", { id: r1.id })).toMatchObject({ ok: true });
  const rows = await calls();
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatchObject({ actor: { type: "job", runId: job.runId }, actorAgentId: job.agentId, jobId: job.runId, result: "ok", resourceType: "row", resourceId: null, details: { tool: "rows_list", tableId: t1.id } });
  expect(rows[1]).toMatchObject({ result: "ok", resourceType: "row", resourceId: rowId, details: { tool: "rows_create", tableId: t1.id } });
  expect(rows[2]).toMatchObject({ result: "ok", resourceType: "row", resourceId: r1.id, details: { tool: "rows_get", tableId: t1.id } });
});

test("a tables_create names the table it created", async () => {
  const { tool, last } = await setup(["configure"], () => "all");
  const created = await tool("tables_create", { name: "Invoices" });
  expect(await last()).toMatchObject({ result: "ok", resourceType: "table", resourceId: (created as { output: { id: string } }).output.id, details: { tool: "tables_create" } });
});

test("each refusal leaves one row with its reason, and none of the input", async () => {
  const { context, job, t1, r2, tool, last, calls } = await setup(["data", "configure"]);
  const refused = async (reason: string, done: Promise<unknown>) => {
    expect(await done).toMatchObject({ ok: false });
    const row = await last();
    expect(row).toMatchObject({ result: "refused", resourceId: null, details: { reason } });
    expect(JSON.stringify(row)).not.toContain(SENTINEL);
    return row;
  };
  expect((await refused("unknown-tool", tool(`${SENTINEL}_tool`))).details).toEqual({ reason: "unknown-tool" });
  // An id that names nothing: no table, no resource id.
  expect((await refused("not-found", tool("rows_get", { id: SENTINEL }))).details).toEqual({ tool: "rows_get", reason: "not-found" });
  expect((await refused("not-found", tool("rows_list", { tableId: SENTINEL }))).details).toEqual({ tool: "rows_list", reason: "not-found" });
  // A real table outside the Job's: not named either, so the Job can't tell it from one that doesn't exist.
  expect((await refused("not-found", tool("rows_get", { id: r2.id }))).details).toEqual({ tool: "rows_get", reason: "not-found" });
  await refused("invalid", tool("rows_list", { tableId: t1.id, limit: -1, note: SENTINEL }));
  await refused("needs-proposal", tool("tables_delete", { id: t1.id }));
  expect((await last()).details).toMatchObject({ tableId: t1.id });
  // The procedure's own refusal: its code.
  await refused("conflict", tool("tables_create", { name: "clients" }));
  // A proposal item used already.
  const made = await tool("propose", { items: [{ tool: "tables_rename", input: { id: t1.id, name: "People" } }] });
  const proposalId = (made as { output: { proposalId: string } }).output.proposalId;
  await context.db.update(proposals).set({ status: "approved" }).where(eq(proposals.id, proposalId));
  expect(await callPlatformTool(context, job, "tables_rename", { id: t1.id, name: "People" }, { proposalId, index: 0 })).toMatchObject({ ok: true });
  await refused("item-used", callPlatformTool(context, job, "tables_rename", { id: t1.id, name: "People" }, { proposalId, index: 0 }));
  // A bundle the Job doesn't have, and a Job that is over.
  const reader = await setup(["data"]);
  expect(await reader.tool("tables_create", { name: SENTINEL })).toMatchObject({ ok: false });
  expect(await reader.last()).toMatchObject({ result: "refused", details: { tool: "tables_create", reason: "bundle" } });
  await reader.context.engine.stopRun(reader.job.runId);
  expect(await reader.tool("rows_list", { tableId: reader.t1.id })).toMatchObject({ ok: false });
  expect(await reader.last()).toMatchObject({ result: "refused", details: { tool: "rows_list", reason: "over" } });
  expect(JSON.stringify(await calls())).not.toContain(SENTINEL);
  expect(JSON.stringify(await reader.calls())).not.toContain(SENTINEL);
});

test("a table deleted on an approved item is still named by its row", async () => {
  const { context, job, t2, tool, last } = await setup(["configure"], () => "all");
  const made = await tool("propose", { items: [{ tool: "tables_delete", input: { id: t2.id } }] });
  const proposalId = (made as { output: { proposalId: string } }).output.proposalId;
  await context.db.update(proposals).set({ status: "approved" }).where(eq(proposals.id, proposalId));
  expect(await callPlatformTool(context, job, "tables_delete", { id: t2.id }, { proposalId, index: 0 })).toMatchObject({ ok: true });
  expect(await last()).toMatchObject({ result: "ok", resourceType: "table", details: { tool: "tables_delete", tableId: t2.id, proposalId, item: 0 } });
});

test("a crash is a failed row, with no words of the error", async () => {
  const { context, job, t1 } = await setup();
  const broken = { ...context, db: { ...context.db, select: context.db.select.bind(context.db), insert: context.db.insert.bind(context.db), transaction: () => Promise.reject(new Error("secret internals")) } } as unknown as typeof context;
  expect(await callPlatformTool(broken, job, "rows_create", { tableId: t1.id })).toEqual({ ok: false, error: "The tool failed" });
  const [row] = await context.db.select().from(audit).where(eq(audit.jobId, job.runId)).orderBy(sql`${audit.at} desc`).limit(1);
  expect(row).toMatchObject({ result: "failed", details: { tool: "rows_create", tableId: t1.id } });
  expect(JSON.stringify(row)).not.toContain("secret internals");
});

test("a proposal applied leaves the apply call and one row per item, in order, with the proposal and the item", async () => {
  const { context, tool, calls } = await setup(["configure"], () => "all");
  const made = await tool("propose", {
    items: [
      { tool: "tables_create", input: { name: "Invoices" } },
      { tool: "fields_create", input: { tableId: { $item: 0 }, name: "Amount", type: "number" } },
    ],
  });
  const proposalId = (made as { output: { proposalId: string } }).output.proposalId;
  await context.db.update(proposals).set({ status: "approved" }).where(eq(proposals.id, proposalId));
  expect(await tool("proposal_apply", { proposalId })).toMatchObject({ ok: true });
  const rows = await calls();
  expect(rows.map((r) => [r.details.tool, r.details.item ?? null, r.result])).toEqual([
    ["propose", null, "ok"],
    ["tables_create", 0, "ok"],
    ["fields_create", 1, "ok"],
    ["proposal_apply", null, "ok"],
  ]);
  const tableId = rows[1]!.resourceId!;
  expect(rows[0]).toMatchObject({ resourceType: "proposal", resourceId: proposalId });
  expect(rows[1]).toMatchObject({ resourceType: "table", details: { proposalId, item: 0 } });
  expect(rows[2]).toMatchObject({ resourceType: "field", details: { proposalId, item: 1, tableId } });
  expect(rows[3]).toMatchObject({ resourceType: "proposal", resourceId: proposalId });
});

test("a call's result is unchanged when its Audit row can't be written", async () => {
  const { context, t1, r1, tool } = await setup();
  await context.db.execute(sql`alter table audit add constraint audit_closed check (false) not valid`);
  onTestFinished(() => context.db.execute(sql`alter table audit drop constraint audit_closed`).then(() => undefined));
  expect(await tool("rows_list", { tableId: t1.id })).toMatchObject({ ok: true, output: { rows: [{ id: r1.id }] } });
  expect(await tool("rows_get", { id: SENTINEL })).toEqual({ ok: false, error: "Not found" });
});

test("every tool has its resource type, and a refused call never an id", () => {
  for (const t of ALL_TOOLS) {
    expect(RESOURCE_OF[resourceKey(t)], t.name).toBeDefined();
    expect(AUDIT_RESOURCES).toContain(RESOURCE_OF[resourceKey(t)]);
    expect(auditResource(t, { id: "row_1", proposalId: "prop_1" }, undefined).id).toBeNull();
  }
  // An output's id is used only when it is an id.
  const rowsGet = ALL_TOOLS.find((t) => t.name === "rows_get")!;
  expect(auditResource(rowsGet, {}, { id: "row 1; a value" })).toEqual({ type: "row", id: null });
  expect(auditResource(rowsGet, {}, { id: "row_1" })).toEqual({ type: "row", id: "row_1" });
});

test("audit_list is a configure tool; a Job on a list of tables reads no row naming another table", async () => {
  const { context, t1, t2, tool } = await setup(["configure"]);
  const { ownerId } = context;
  const other = { ownerId, actor: { type: "job" as const, runId: "run_other" }, agentId: "agent_other", jobId: "run_other", action: "platform.call" as const };
  // 51 rows about t2, by details or as a table resource: more than a page.
  for (let i = 0; i < 51; i++) {
    await recordAudit(context.db, i % 2 ? { ...other, resource: { type: "row" }, details: { tool: "rows_list", tableId: t2.id } } : { ...other, resource: { type: "table", id: t2.id }, details: { tool: "tables_get" } });
  }
  expect(await tool("audit_list", { jobId: "run_other" })).toEqual({ ok: true, output: { rows: [], next: null } });
  await recordAudit(context.db, { ...other, resource: { type: "table", id: t1.id }, details: { tool: "tables_get", tableId: t1.id } });
  await recordAudit(context.db, { ...other, resource: { type: "agent", id: "agent_other" }, details: { tool: "agents_get" } });
  const listed = await tool("audit_list", { jobId: "run_other" });
  expect((listed as { output: { rows: { details: unknown }[] } }).output.rows.map((r) => r.details)).toEqual([{ tool: "agents_get" }, { tool: "tables_get", tableId: t1.id }]);
  // The owner sees them all.
  expect((await call(router.audit.list, { jobId: "run_other" }, { context })).rows).toHaveLength(50);
  // Its own call is audited, and the trace URL is not a tool.
  expect(await tool("audit_trace_url")).toEqual({ ok: false, error: "Unknown tool" });
  const reader = await setup(["data"]);
  expect(await reader.tool("audit_list")).toMatchObject({ ok: false, error: "This agent may not use audit_list" });
  // On no table at all: only the rows naming none.
  const bare = await setup(["configure"], () => []);
  await recordAudit(bare.context.db, { ...other, ownerId: bare.context.ownerId, resource: { type: "table", id: bare.t1.id }, details: { tableId: bare.t1.id } });
  await recordAudit(bare.context.db, { ...other, ownerId: bare.context.ownerId, resource: { type: "agent", id: "agent_other" } });
  const seen = await bare.tool("audit_list", { jobId: "run_other" });
  expect((seen as { output: { rows: { resourceType: string }[] } }).output.rows.map((r) => r.resourceType)).toEqual(["agent"]);
});
