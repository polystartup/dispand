import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import type { ChatItem } from "../cloud/model-client.ts";
import type { ToolCaller } from "../cloud/runner.ts";
import { fakeModel, say, use, type Script } from "../cloud/test-model.ts";
import { questions, runs } from "../db/schema.ts";
import { createEngine } from "../engine/cli-harness.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import type { MemoryTarget } from "../memory/model.ts";
import { listMemory } from "../memory/store.ts";
import type { Bundle } from "./bundles.ts";
import { platformToolCaller } from "./cloud.ts";

/** A cloud agent with `bundles` on the table "Clients", and an engine whose cloud sessions get Dispand's tools (or `tools`). */
async function setup(bundles: Bundle[], script: Script[], tools?: ToolCaller, selfLearning: MemoryTarget[] = []) {
  const base = await ownerContext();
  const model = fakeModel(...script);
  const engine = createEngine(base.db, base.hub, base.secrets, base.dataEvents, { tools: tools ?? platformToolCaller(() => context), client: model.client });
  onTestFinished(() => engine.stop());
  const context = { ...base, engine };
  const harness = await call(
    router.harnesses.create,
    { type: "cloud", name: "API", kind: "openai-compatible", baseUrl: "https://llm.test/v1", model: "m", systemPrompt: "You work for Dispand." } as never,
    { context },
  );
  const table = await call(router.tables.create, { name: "Clients" }, { context });
  const other = await call(router.tables.create, { name: "Matters" }, { context });
  const name = (await call(router.tables.get, { id: table.id }, { context })).fields[0]!;
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "Be brief.", bundles, dataTables: [table.id], selfLearning }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Add the client.", config: { kind: "manual", placement: "button" } }, { context });
  const until = (runId: string, status: string) =>
    vi.waitFor(async () => {
      const [run] = await context.db.select().from(runs).where(eq(runs.id, runId));
      if (run!.status !== status) throw new Error(`run is ${run!.status}`);
      return run!;
    });
  return { context, engine, model, table, other, name, agent, trigger, until };
}

const lastTool = (items: ChatItem[]) => items.findLast((i) => i.role === "tool") as Extract<ChatItem, { role: "tool" }>;

test("a cloud Job creates a row through rows_create, with no question asked", async () => {
  // The script needs the table's ids, which the setup makes: the first turn reads them when it runs.
  const ids = { tableId: "", fieldId: "" };
  const again = await setup(["data"], [() => ({ toolCalls: [{ id: "c1", name: "rows_create", args: { tableId: ids.tableId, values: { [ids.fieldId]: "Ada" } } }] }), say("Done.")]);
  Object.assign(ids, { tableId: again.table.id, fieldId: again.name.id });
  const { runId } = await call(router.jobs.start, { triggerId: again.trigger.id }, { context: again.context });
  await again.until(runId, "succeeded");
  // The row exists, and nobody was asked.
  const listed = await call(router.rows.list, { tableId: again.table.id }, { context: again.context });
  expect(listed.rows.map((r) => r.values[again.name.id])).toEqual(["Ada"]);
  expect(await again.context.db.select().from(questions)).toEqual([]);
  // The model was given the data tools, with their schemas, and none of the configure ones.
  const offered = again.model.inputs[0]!.tools;
  expect(offered.map((t) => t.name)).toEqual(expect.arrayContaining(["tables_list", "tables_get", "rows_list", "rows_get", "rows_create", "rows_update", "rows_delete"]));
  expect(offered.map((t) => t.name)).not.toContain("tables_create");
  expect(offered.find((t) => t.name === "rows_create")).toMatchObject({ description: expect.stringContaining("row"), inputSchema: { type: "object", properties: { tableId: { type: "string" } } } });
  expect(lastTool(again.model.inputs[1]!.items)).toMatchObject({ isError: false, result: expect.stringContaining("Ada") });
});

test("the model sees a refusal as a tool error and the Job goes on", async () => {
  const again = await setup(["data"], [use("rows_list", { tableId: "table_out_of_scope" }), say("I can't reach it.")]);
  const { runId } = await call(router.jobs.start, { triggerId: again.trigger.id }, { context: again.context });
  await again.until(runId, "succeeded");
  expect(lastTool(again.model.inputs[1]!.items)).toMatchObject({ isError: true, result: "Not found" });
});

test("a cloud Job that learns writes its agent's memory with memory_add", async () => {
  const s = await setup(["data"], [use("memory_add", { scope: "agent", path: "habits.md", name: "Habits", description: "How the owner likes it", type: "practice", body: "Short answers." }), say("Noted.")], undefined, ["agent"]);
  const { runId } = await call(router.jobs.start, { triggerId: s.trigger.id }, { context: s.context });
  await s.until(runId, "succeeded");
  expect(s.model.inputs[0]!.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["memory_read", "memory_add", "memory_update", "memory_remove"]));
  expect(lastTool(s.model.inputs[1]!.items)).toMatchObject({ isError: false });
  expect(await listMemory(s.context.db, s.context.ownerId, { scope: "agent", agentId: s.agent.id })).toMatchObject([{ path: "habits.md", body: "Short answers.", author: { type: "agent", runId } }]);
});

test("a workflow run's cloud session gets no platform tool", async () => {
  const s = await setup(["data", "configure"], [say("Here is the note.")]);
  const workflow = await call(router.workflows.create, { name: "Ship" }, { context: s.context });
  await call(
    router.workflows.update,
    {
      id: workflow.id,
      name: "Ship",
      def: {
        trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } },
        steps: [{ id: "n_note", key: "note", type: "agent", name: "Note", agentId: s.agent.id, prompt: "Write a note." }],
        edges: [{ from: "n_go", to: "n_note" }],
      },
    },
    { context: s.context },
  );
  const { runId } = await call(router.runs.start, { workflowId: workflow.id }, { context: s.context });
  await s.until(runId, "succeeded");
  expect(s.model.inputs[0]!.tools.map((t) => t.name)).toEqual(["ask_user", "request_approval"]);
});

test("a tool that isn't Dispand's own still asks before it runs", async () => {
  const calls: unknown[] = [];
  const tools: ToolCaller = {
    specs: async () => [{ key: "t1:send", label: "Mail send", spec: { name: "", description: "Send a mail", inputSchema: { type: "object" } } }],
    call: async (_session, key, args) => {
      calls.push([key, args]);
      return { text: "sent", isError: false };
    },
  };
  const s = await setup(["data"], [use("Mail_send", { to: "x" }), say("Sent.")], tools);
  const { runId } = await call(router.jobs.start, { triggerId: s.trigger.id }, { context: s.context });
  await s.until(runId, "waiting");
  expect(await s.context.db.select({ status: questions.status }).from(questions)).toEqual([{ status: "pending" }]);
  expect(calls).toEqual([]);
});

test("a denied approval stops the other calls the model made in the same turn", async () => {
  const ids = { tableId: "", fieldId: "" };
  const s = await setup(["data"], [
    () => ({
      toolCalls: [
        { id: "a", name: "request_approval", args: { message: "Add Ada to the clients?" } },
        { id: "b", name: "rows_create", args: { tableId: ids.tableId, values: { [ids.fieldId]: "Ada" } } },
      ],
    }),
    say("Not added."),
  ]);
  Object.assign(ids, { tableId: s.table.id, fieldId: s.name.id });
  const { runId } = await call(router.jobs.start, { triggerId: s.trigger.id }, { context: s.context });
  const q = await vi.waitFor(async () => {
    const [row] = await s.context.db.select().from(questions).where(eq(questions.runId, runId));
    if (row?.status !== "pending") throw new Error("no pending question yet");
    return row;
  });
  await s.engine.answer(q.id, { kind: "permission", decision: "deny" });
  await s.until(runId, "succeeded");
  // The row was not created: the "no" covers what was asked with it.
  expect((await call(router.rows.list, { tableId: s.table.id }, { context: s.context })).rows).toEqual([]);
  const results = s.model.inputs[1]!.items.filter((i) => i.role === "tool") as Extract<ChatItem, { role: "tool" }>[];
  expect(results.map((r) => [r.callId, r.isError])).toEqual([["a", true], ["b", true]]);
  expect(results[1]!.result).toMatch(/Not run/);
});

test("an approved request lets the turn's other calls run", async () => {
  const ids = { tableId: "", fieldId: "" };
  const s = await setup(["data"], [
    () => ({
      toolCalls: [
        { id: "a", name: "request_approval", args: { message: "Add Ada to the clients?" } },
        { id: "b", name: "rows_create", args: { tableId: ids.tableId, values: { [ids.fieldId]: "Ada" } } },
      ],
    }),
    say("Added."),
  ]);
  Object.assign(ids, { tableId: s.table.id, fieldId: s.name.id });
  const { runId } = await call(router.jobs.start, { triggerId: s.trigger.id }, { context: s.context });
  const q = await vi.waitFor(async () => {
    const [row] = await s.context.db.select().from(questions).where(eq(questions.runId, runId));
    if (row?.status !== "pending") throw new Error("no pending question yet");
    return row;
  });
  await s.engine.answer(q.id, { kind: "permission", decision: "allow" });
  await s.until(runId, "succeeded");
  expect((await call(router.rows.list, { tableId: s.table.id }, { context: s.context })).rows).toHaveLength(1);
});
