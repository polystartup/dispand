import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { rows, runs, stepRuns, tables, user } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import type { DataStep, WorkflowDef } from "../workflows/model.ts";
import { Engine } from "./engine.ts";
import type { Harness, HarnessAdapter, StartParams } from "./harness.ts";

class FakeAdapter implements HarnessAdapter {
  starts: { harness: Harness; start: StartParams }[] = [];
  async start(harness: Harness, start: StartParams) {
    this.starts.push({ harness, start });
    return true;
  }
  async send() {
    return true;
  }
  async answer() {
    return true;
  }
  async stop() {
    return true;
  }
}

type Ids = { agentId: string; tableId: string; nameId: string; priceId: string };

const chat = (agentId: string): WorkflowDef["trigger"] => ({
  type: "manual",
  field: { id: "n_chat", key: "brief", type: "chat", label: "Brief", agentId, prompt: "Ask what to build." },
});

const createProject = (ids: Ids): DataStep => ({
  id: "n_data",
  key: "create_project",
  type: "data",
  name: "Create project",
  action: "create-row",
  tableId: ids.tableId,
  inputs: [
    { fieldId: ids.nameId, source: { type: "output", nodeId: "n_chat", name: "name" } },
    { fieldId: ids.priceId, source: { type: "output", nodeId: "n_chat", name: "price" } },
  ],
});

/** Chat "Brief" → create a row of Projects: Name ← brief.name, Price ← brief.price. */
const chatThenCreate = (ids: Ids): WorkflowDef => ({ trigger: chat(ids.agentId), steps: [createProject(ids)], edges: [{ from: "n_chat", to: "n_data" }] });

async function setup(def: (ids: Ids) => WorkflowDef) {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(
    await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "acceptEdits" }, { context }),
  );
  const agent = await call(router.agents.create, { name: "Writer", harnessId: harness.id, systemPrompt: "Be brief." }, { context });
  const table = await call(router.tables.create, { name: "Projects" }, { context });
  const price = await call(router.fields.create, { tableId: table.id, name: "Price", type: "number" }, { context });
  const ids = { agentId: agent.id, tableId: table.id, nameId: table.fields[0]!.id, priceId: price.id };
  const workflow = await call(router.workflows.create, { name: "Ship" }, { context });
  await call(router.workflows.update, { id: workflow.id, name: "Ship", def: def(ids) }, { context });
  const adapter = new FakeAdapter();
  const engine = new Engine(context.db, adapter, undefined, context.dataEvents);
  onTestFinished(() => engine.stop());
  let seq = 0;
  const emit = (sessionId: string, event: Parameters<Engine["onHarnessEvent"]>[1]) => engine.onHarnessEvent(sessionId, event, { runnerId, seq: ++seq });
  return { context, runnerId, adapter, engine, emit, workflow, ids };
}

async function runOf(engine: Engine, runId: string) {
  const [run] = await engine.db.select().from(runs).where(eq(runs.id, runId));
  const steps = await engine.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
  return { run: run!, steps: Object.fromEntries(steps.map((s) => [s.nodeId, s])) };
}

test("a chat's confirmed outputs become a row, and the step gives its row id", async () => {
  const { context, adapter, engine, emit, workflow, ids } = await setup(chatThenCreate);
  const runId = await engine.startRun(workflow.id);
  // The chat is told what each value is for.
  expect(adapter.starts[0]!.start.expectedOutputs).toEqual([
    { name: "name", type: "string", description: "For “Name” in Projects: text" },
    { name: "price", type: "string", description: "For “Price” in Projects: a number" },
  ]);
  await emit(adapter.starts[0]!.start.sessionId, { type: "outputs-accepted", values: { name: "Dispand", price: "12,5" } });
  const { run, steps } = await runOf(engine, runId);
  expect(run.status).toBe("succeeded");
  const [row] = (await call(router.rows.list, { tableId: ids.tableId }, { context })).rows;
  expect(row!.values).toEqual({ [ids.nameId]: "Dispand", [ids.priceId]: 12.5 });
  expect(steps["n_data"]).toMatchObject({ status: "succeeded", outputs: { row_id: row!.id } });
});

test("an output that doesn't fit its field fails the step and writes no row", async () => {
  const { context, adapter, engine, emit, workflow, ids } = await setup(chatThenCreate);
  const runId = await engine.startRun(workflow.id);
  await emit(adapter.starts[0]!.start.sessionId, { type: "outputs-accepted", values: { name: "X", price: "lots" } });
  const { run, steps } = await runOf(engine, runId);
  expect(steps["n_data"]).toMatchObject({ status: "failed", error: "“Price”: expected a number, got “lots”" });
  expect(run).toMatchObject({ status: "failed", error: "“Price”: expected a number, got “lots”" });
  expect((await call(router.rows.list, { tableId: ids.tableId }, { context })).total).toBe(0);
});

test("update-row writes to the row a create-row step made", async () => {
  const { context, adapter, engine, emit, workflow, ids } = await setup((ids) => ({
    trigger: chat(ids.agentId),
    steps: [
      createProject(ids),
      {
        id: "n_update",
        key: "update_price",
        type: "data",
        name: "Update price",
        action: "update-row",
        tableId: ids.tableId,
        rowId: { type: "output", nodeId: "n_data", name: "row_id" },
        inputs: [{ fieldId: ids.priceId, source: { type: "value", value: "99" } }],
      },
    ],
    edges: [
      { from: "n_chat", to: "n_data" },
      { from: "n_data", to: "n_update" },
    ],
  }));
  const runId = await engine.startRun(workflow.id);
  await emit(adapter.starts[0]!.start.sessionId, { type: "outputs-accepted", values: { name: "Dispand", price: "1" } });
  const { run, steps } = await runOf(engine, runId);
  expect(run.status).toBe("succeeded");
  const { rows: found } = await call(router.rows.list, { tableId: ids.tableId }, { context });
  expect(found).toHaveLength(1);
  expect(found[0]!.values).toEqual({ [ids.nameId]: "Dispand", [ids.priceId]: 99 });
  expect(steps["n_update"]!.outputs).toEqual({ row_id: found[0]!.id });
});

test("update-row refuses a row of another table", async () => {
  const { context, adapter, engine, emit, workflow, ids } = await setup((ids) => ({
    trigger: chat(ids.agentId),
    steps: [
      {
        id: "n_update",
        key: "update",
        type: "data",
        name: "Update",
        action: "update-row",
        tableId: ids.tableId,
        rowId: { type: "output", nodeId: "n_chat", name: "row" },
        inputs: [{ fieldId: ids.priceId, source: { type: "value", value: "1" } }],
      },
    ],
    edges: [{ from: "n_chat", to: "n_update" }],
  }));
  const other = await call(router.tables.create, { name: "Other" }, { context });
  const foreign = await call(router.rows.create, { tableId: other.id, values: { [other.fields[0]!.id]: "kept" } }, { context });
  const runId = await engine.startRun(workflow.id);
  await emit(adapter.starts[0]!.start.sessionId, { type: "outputs-accepted", values: { row: foreign.id } });
  expect((await runOf(engine, runId)).steps["n_update"]).toMatchObject({ status: "failed", error: `row “${foreign.id}” is not in Projects` });
  expect((await call(router.rows.get, { id: foreign.id }, { context })).values).toEqual({ [other.fields[0]!.id]: "kept" });
  void ids;
});

test("find-rows gives count, the first row id and the rows as JSON to the next agent's prompt", async () => {
  const { context, adapter, engine, emit, workflow, ids } = await setup((ids) => ({
    trigger: chat(ids.agentId),
    steps: [
      {
        id: "n_find",
        key: "find",
        type: "data",
        name: "Find",
        action: "find-rows",
        tableId: ids.tableId,
        filters: [
          { fieldId: ids.nameId, op: "contains", value: { type: "output", nodeId: "n_chat", name: "name" } },
          { fieldId: ids.priceId, op: ">", value: { type: "value", value: "10" } },
        ],
        limit: 20,
      },
      { id: "n_report", key: "report", type: "agent", name: "Report", agentId: ids.agentId, prompt: "Found {{find.count}}, first {{find.row_id}}: {{find.rows}}" },
    ],
    edges: [
      { from: "n_chat", to: "n_find" },
      { from: "n_find", to: "n_report" },
    ],
  }));
  const cheap = await call(router.rows.create, { tableId: ids.tableId, values: { [ids.nameId]: "Dispand lite", [ids.priceId]: 5 } }, { context });
  const first = await call(router.rows.create, { tableId: ids.tableId, values: { [ids.nameId]: "Dispand", [ids.priceId]: 12.5 } }, { context });
  await call(router.rows.create, { tableId: ids.tableId, values: { [ids.nameId]: "Other", [ids.priceId]: 50 } }, { context });
  void cheap;
  const runId = await engine.startRun(workflow.id);
  await emit(adapter.starts[0]!.start.sessionId, { type: "outputs-accepted", values: { name: "dispand" } });
  const { steps } = await runOf(engine, runId);
  const rowsJson = JSON.stringify([{ id: first.id, Name: "Dispand", Price: "12.5" }]);
  expect(steps["n_find"]).toMatchObject({ status: "succeeded", outputs: { count: "1", row_id: first.id, rows: rowsJson } });
  expect(adapter.starts[1]!.start.prompt).toBe(`Found 1, first ${first.id}: ${rowsJson}`);
  expect(adapter.starts[1]!.start.prompt).toContain('"Name":"Dispand"');
});

test("find-rows with an empty wired value where its op needs one fails the step", async () => {
  const { adapter, engine, emit, workflow } = await setup((ids) => ({
    trigger: chat(ids.agentId),
    steps: [
      {
        id: "n_find",
        key: "find",
        type: "data",
        name: "Find",
        action: "find-rows",
        tableId: ids.tableId,
        filters: [{ fieldId: ids.priceId, op: ">", value: { type: "output", nodeId: "n_chat", name: "budget" } }],
        limit: 20,
      },
    ],
    edges: [{ from: "n_chat", to: "n_find" }],
  }));
  const runId = await engine.startRun(workflow.id);
  await emit(adapter.starts[0]!.start.sessionId, { type: "outputs-accepted", values: { budget: " " } });
  expect((await runOf(engine, runId)).steps["n_find"]).toMatchObject({ status: "failed", error: "“Price”: a value is needed" });
});

test("a data step writes its row once across a restart and a retried advance", async () => {
  const { context, runnerId, adapter, engine, emit, workflow, ids } = await setup(chatThenCreate);
  const runId = await engine.startRun(workflow.id);
  const { sessionId } = adapter.starts[0]!.start;
  const accepted = { type: "outputs-accepted" as const, values: { name: "Dispand", price: "3" } };
  await emit(sessionId, accepted);
  // The hub replays the event (same seq), and the app restarts.
  await engine.onHarnessEvent(sessionId, accepted, { runnerId, seq: 1 });
  const restarted = new Engine(context.db, new FakeAdapter(), undefined, context.dataEvents);
  onTestFinished(() => restarted.stop());
  await restarted.recover();
  // Two engines advance the same run at once (a retried advance racing the first).
  await context.db.update(stepRuns).set({ status: "pending", outputs: null, finishedAt: null }).where(eq(stepRuns.nodeId, "n_data"));
  await context.db.update(runs).set({ status: "running", finishedAt: null }).where(eq(runs.id, runId));
  const before = (await call(router.rows.list, { tableId: ids.tableId }, { context })).total;
  expect(before).toBe(1);
  await Promise.all([engine.recover(), restarted.recover()]);
  expect((await call(router.rows.list, { tableId: ids.tableId }, { context })).total).toBe(2);
  expect((await runOf(engine, runId)).run.status).toBe("succeeded");
});

test("a field deleted mid-run fails the data step", async () => {
  const { context, adapter, engine, emit, workflow, ids } = await setup(chatThenCreate);
  const runId = await engine.startRun(workflow.id);
  await call(router.fields.delete, { id: ids.priceId }, { context });
  await emit(adapter.starts[0]!.start.sessionId, { type: "outputs-accepted", values: { name: "X", price: "3" } });
  expect((await runOf(engine, runId)).steps["n_data"]).toMatchObject({ status: "failed", error: "A field this step sets no longer exists in Projects" });
  expect((await call(router.rows.list, { tableId: ids.tableId }, { context })).total).toBe(0);
});

test("a field retyped to files mid-run fails the data step and keeps the row's files", async () => {
  const { context, adapter, engine, emit, workflow, ids } = await setup(chatThenCreate);
  const runId = await engine.startRun(workflow.id);
  await call(router.fields.retype, { id: ids.priceId, type: "attachment", dryRun: false }, { context });
  await emit(adapter.starts[0]!.start.sessionId, { type: "outputs-accepted", values: { name: "X", price: "" } });
  expect((await runOf(engine, runId)).steps["n_data"]).toMatchObject({ status: "failed", error: "“Price” holds files, which a workflow can't set" });
  expect((await call(router.rows.list, { tableId: ids.tableId }, { context })).total).toBe(0);
});

test("data steps publish row changes", async () => {
  const { context, adapter, engine, emit, workflow, ids } = await setup(chatThenCreate);
  const controller = new AbortController();
  const events = context.dataEvents.subscribe([ids.tableId], controller.signal)[Symbol.asyncIterator]();
  const runId = await engine.startRun(workflow.id);
  await emit(adapter.starts[0]!.start.sessionId, { type: "outputs-accepted", values: { name: "X", price: "3" } });
  const rowId = (await runOf(engine, runId)).steps["n_data"]!.outputs!.row_id;
  expect((await events.next()).value).toEqual({ type: "rows", tableId: ids.tableId, rowIds: [rowId] });
  controller.abort();
});

test("a data step can't name another owner's table", async () => {
  const { context, workflow, ids } = await setup(chatThenCreate);
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.insert(tables).values({ id: "tbl_other", ownerId: "user_other", name: "Secrets" });
  const def = chatThenCreate({ ...ids, tableId: "tbl_other" });
  await expect(call(router.workflows.update, { id: workflow.id, name: "Ship", def }, { context })).rejects.toMatchObject({
    code: "NOT_FOUND",
    message: "Table not found",
  });
});

test("runs.start refuses a data step whose field was deleted", async () => {
  const { context, workflow, ids } = await setup(chatThenCreate);
  await call(router.fields.delete, { id: ids.priceId }, { context });
  await expect(call(router.runs.start, { workflowId: workflow.id }, { context })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "Fix the workflow first: A field this step sets no longer exists in Projects",
  });
});

test("table delete refused while a workflow uses it", async () => {
  const { context, workflow, ids } = await setup(chatThenCreate);
  await expect(call(router.tables.delete, { id: ids.tableId }, { context })).rejects.toMatchObject({
    code: "CONFLICT",
    message: "A workflow uses this table",
  });
  const def = { ...chatThenCreate(ids), steps: [], edges: [] };
  await call(router.workflows.update, { id: workflow.id, name: "Ship", def }, { context });
  await call(router.tables.delete, { id: ids.tableId }, { context });
  expect(await context.db.select().from(rows)).toEqual([]);
});
