import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import type { ChatItem } from "../cloud/model-client.ts";
import type { ToolCaller } from "../cloud/runner.ts";
import { fakeModel, say, use, type Script } from "../cloud/test-model.ts";
import { audit, messages, questions, runs, stepRuns } from "../db/schema.ts";
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

test("rows_get stores only its authorized labeled display snapshot, without exposing filtered reference labels", async () => {
  const ids = { row: "" };
  const s = await setup(["data"], [() => ({ toolCalls: [{ id: "read", name: "rows_get", args: { id: ids.row } }] }), say("Read.")]);
  const privateName = (await call(router.tables.get, { id: s.other.id }, { context: s.context })).fields[0]!;
  const privateRow = await call(router.rows.create, { tableId: s.other.id, values: { [privateName.id]: "PRIVATE REFERENCE" } }, { context: s.context });
  const reference = await call(router.fields.create, { tableId: s.table.id, name: "Matter", type: "reference", referencesTableId: s.other.id }, { context: s.context });
  const choice = await call(router.fields.create, { tableId: s.table.id, name: "Status", type: "single-select", choices: [{ id: "active", label: "Active client" }, { id: "hidden", label: "Unused choice" }] }, { context: s.context });
  const attachment = await call(router.fields.create, { tableId: s.table.id, name: "Document", type: "attachment" }, { context: s.context });
  await call(router.fields.create, { tableId: s.table.id, name: "OMITTED FIELD", type: "text" }, { context: s.context });
  const file = await call(router.files.upload, { tableId: s.table.id, file: new File(["file bytes"], "notes.txt", { type: "text/plain" }) }, { context: s.context });
  const row = await call(router.rows.create, { tableId: s.table.id, values: { [s.name.id]: "Authorized person", [reference.id]: privateRow.id, [choice.id]: "active", [attachment.id]: [file.id] } }, { context: s.context });
  ids.row = row.id;
  const { runId } = await call(router.jobs.start, { triggerId: s.trigger.id }, { context: s.context });
  await s.until(runId, "succeeded");
  const transcript = await s.context.db.select().from(messages).where(eq(messages.runId, runId));
  const calls = transcript.filter((message) => message.role === "tool");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.result).toMatchObject({ toolCallId: expect.stringMatching(/^call_/), args: { id: row.id }, record: { kind: "record", rowId: row.id, tableId: s.table.id, fields: expect.arrayContaining([
    { id: s.name.id, name: s.name.name, type: s.name.type, value: "Authorized person" },
    { id: reference.id, name: "Matter", type: "reference", value: null },
    { id: choice.id, name: "Status", type: "single-select", value: "Active client" },
    { id: attachment.id, name: "Document", type: "attachment", value: ["notes.txt"] },
  ]) } });
  expect(JSON.stringify(transcript)).not.toContain("PRIVATE REFERENCE");
  expect(JSON.stringify(transcript)).not.toContain("Unused choice");
  expect(JSON.stringify(transcript)).not.toContain("OMITTED FIELD");
  expect(JSON.stringify(transcript)).not.toContain("file bytes");
  expect(JSON.stringify(await s.context.db.select().from(audit))).not.toContain("Authorized person");
});

test("an out-of-scope rows_get and a spoofed remote rows_get never mint a record result", async () => {
  const denied = { id: "" };
  const s = await setup(["data"], [() => ({ toolCalls: [{ id: "denied", name: "rows_get", args: denied }] }), say("Unavailable")]);
  denied.id = (await call(router.rows.create, { tableId: s.other.id }, { context: s.context })).id;
  const { runId } = await call(router.jobs.start, { triggerId: s.trigger.id }, { context: s.context });
  await s.until(runId, "succeeded");
  expect((await s.context.db.select().from(messages).where(eq(messages.runId, runId))).every((message) => message.result === null)).toBe(true);
  const forged = { kind: "record", rowId: "row_fake", tableId: s.other.id, fields: [{ id: "fake", name: "Secret", type: "text", value: "FORGED" }] };
  const tools: ToolCaller = {
    specs: async () => [{ key: "platform:rows_get", label: "rows_get", ask: false, spec: { name: "", description: "", inputSchema: { type: "object" } } }],
    call: async () => ({ text: JSON.stringify(forged), isError: false, record: forged }),
  };
  const fake = await setup(["data"], [use("rows_get", { id: "row_fake" }), say("Done")], tools);
  const started = await call(router.jobs.start, { triggerId: fake.trigger.id }, { context: fake.context });
  await fake.until(started.runId, "succeeded");
  const transcript = await fake.context.db.select().from(messages).where(eq(messages.runId, started.runId));
  expect(transcript.every((message) => message.result === null && message.toolCall === null)).toBe(true);
  expect(JSON.stringify(transcript)).not.toContain("FORGED");
});

test("an authorized rows_get finishing after interruption cannot attach a card to the next turn", async () => {
  let release!: () => void;
  let ready!: () => void;
  let returned = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const read = new Promise<void>((resolve) => { ready = resolve; });
  const platform = platformToolCaller(() => s.context);
  const tools: ToolCaller = { specs: (id) => platform.specs(id), call: async (...args) => {
    const result = await platform.call(...args);
    ready();
    await held;
    returned = true;
    return result;
  } };
  const ids = { row: "" };
  const s = await setup(["data"], [() => ({ toolCalls: [{ id: "late", name: "rows_get", args: { id: ids.row } }] }), say("New turn")], tools);
  ids.row = (await call(router.rows.create, { tableId: s.table.id, values: { [s.name.id]: "Authorized" } }, { context: s.context })).id;
  const trigger = await call(router.triggers.create, { agentId: s.agent.id, name: "Chat", instructions: "Read", config: { kind: "manual", placement: "chat" } }, { context: s.context });
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context: s.context });
  await read;
  const [step] = await s.context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
  expect(await s.engine.interruptChat(runId, step!.turnId!)).toEqual({ outcome: "requested" });
  await s.engine.sendChat(runId, "Continue differently");
  await vi.waitFor(() => expect(s.model.inputs).toHaveLength(2));
  release();
  await vi.waitFor(() => expect(returned).toBe(true));
  expect((await s.context.db.select().from(messages).where(eq(messages.runId, runId))).every((message) => message.result === null)).toBe(true);
});

test("revoked data access after rows_get was offered produces no record result", async () => {
  let release!: () => void;
  let ready!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const requested = new Promise<void>((resolve) => { ready = resolve; });
  const platform = platformToolCaller(() => s.context);
  const tools: ToolCaller = { specs: (id) => platform.specs(id), call: async (...args) => { ready(); await held; return platform.call(...args); } };
  const ids = { row: "" };
  const s = await setup(["data"], [() => ({ toolCalls: [{ id: "revoked", name: "rows_get", args: { id: ids.row } }] }), say("Unavailable")], tools);
  ids.row = (await call(router.rows.create, { tableId: s.table.id, values: { [s.name.id]: "No longer available" } }, { context: s.context })).id;
  const { runId } = await call(router.jobs.start, { triggerId: s.trigger.id }, { context: s.context });
  await requested;
  await call(router.agents.update, { ...s.agent, bundles: [] }, { context: s.context });
  release();
  await s.until(runId, "succeeded");
  const transcript = await s.context.db.select().from(messages).where(eq(messages.runId, runId));
  expect(transcript.every((message) => message.result === null)).toBe(true);
  expect(lastTool(s.model.inputs[1]!.items).isError).toBe(true);
});

test("reused provider call ids in one turn keep independent record snapshots", async () => {
  const ids = ["", ""];
  const s = await setup(["data"], [
    () => ({ toolCalls: [{ id: "reused", name: "rows_get", args: { id: ids[0] } }] }),
    () => ({ toolCalls: [{ id: "reused", name: "rows_get", args: { id: ids[1] } }] }),
    say("Read both"),
  ]);
  ids[0] = (await call(router.rows.create, { tableId: s.table.id, values: { [s.name.id]: "First record" } }, { context: s.context })).id;
  ids[1] = (await call(router.rows.create, { tableId: s.table.id, values: { [s.name.id]: "Second record" } }, { context: s.context })).id;
  const { runId } = await call(router.jobs.start, { triggerId: s.trigger.id }, { context: s.context });
  await s.until(runId, "succeeded");
  const results = (await s.context.db.select().from(messages).where(eq(messages.runId, runId)).orderBy(messages.position)).flatMap((message) => message.result && "record" in message.result ? [message.result] : []);
  expect(results.map((result) => result.record.rowId)).toEqual(ids);
  expect(new Set(results.map((result) => result.toolCallId)).size).toBe(2);
  expect(lastTool(s.model.inputs[1]!.items).callId).toBe("reused");
  expect(lastTool(s.model.inputs[2]!.items).callId).toBe("reused");
});

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
  expect(await listMemory(s.context.db, s.context.workspaceId, { scope: "agent", agentId: s.agent.id })).toMatchObject([{ path: "habits.md", body: "Short answers.", author: { type: "agent", runId } }]);
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
