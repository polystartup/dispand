import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import type { ChatItem } from "../cloud/model-client.ts";
import { fakeModel, say, use, type Script } from "../cloud/test-model.ts";
import { attachments, questions, runs, tools as toolsTable } from "../db/schema.ts";
import { createEngine } from "../engine/cli-harness.ts";
import { platformToolCaller } from "../platform/cloud.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import { startFakeMcp, type FakeMcp } from "./test-server.ts";

const servers: FakeMcp[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const SECRET = "Bearer s3cret-value";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

/** A cloud agent with the HTTP tool "GitHub" (`create_repository`, `list_repos`), and an engine wired as the app's. */
async function setup(script: Script[]) {
  const base = await ownerContext();
  const calls: [string, Record<string, unknown>][] = [];
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  const server = await startFakeMcp([
    { name: "create_repository", description: "Create a repository", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, call: (args) => (calls.push(["create_repository", args]), text("created")) },
    { name: "list_repos", description: "List repositories", inputSchema: { type: "object", properties: {} }, call: (args) => (calls.push(["list_repos", args]), text("[]")) },
    { name: "get_logo", annotations: { readOnlyHint: true }, call: () => ({ content: [{ type: "image" as const, data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" }] }) },
  ]);
  servers.push(server);
  const model = fakeModel(...script);
  const engine = createEngine(base.db, base.hub, base.secrets, base.dataEvents, { connector: base.tools, tools: platformToolCaller(() => context), client: model.client, filesDir: base.filesDir });
  onTestFinished(() => engine.stop());
  const context = { ...base, engine };
  const harness = await call(
    router.harnesses.create,
    { type: "cloud", name: "API", kind: "openai-compatible", baseUrl: "https://llm.test/v1", model: "m", systemPrompt: "You work for Dispand." } as never,
    { context },
  );
  const tool = await call(router.tools.create, { name: "GitHub", url: server.url, transport: "streamable-http", headers: { Authorization: SECRET } }, { context });
  const fields = { name: "Clerk", harnessId: harness.id, systemPrompt: "Be brief." };
  const agent = await call(router.agents.create, { ...fields, toolIds: [tool.id], bundles: ["data"] }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Make the repository.", config: { kind: "manual", placement: "button" } }, { context });
  const until = (runId: string, status: string) =>
    vi.waitFor(async () => {
      const [run] = await context.db.select().from(runs).where(eq(runs.id, runId));
      if (run!.status !== status) throw new Error(`run is ${run!.status}`);
    });
  const pending = (runId: string) =>
    vi.waitFor(async () => {
      const [q] = await context.db.select().from(questions).where(eq(questions.runId, runId));
      if (q?.status !== "pending") throw new Error("no pending question yet");
      return q;
    });
  const start = async () => (await call(router.jobs.start, { triggerId: trigger.id }, { context })).runId;
  return { context, engine, model, server, calls, tool, agent, fields, start, until, pending };
}

const lastTool = (items: ChatItem[]) => items.findLast((i) => i.role === "tool") as Extract<ChatItem, { role: "tool" }>;

test("a cloud Job calls its agent's HTTP tool after the owner allows it; the headers stay on the server", async () => {
  const s = await setup([use("GitHub_create_repository", { name: "acme" }), say("Done.")]);
  const runId = await s.start();
  const q = await s.pending(runId);
  expect(q.payload).toMatchObject({ kind: "permission", toolName: "GitHub create_repository", input: { name: "acme" }, canAlwaysAllow: true });
  expect(s.calls).toEqual([]);
  await s.engine.answer(q.id, { kind: "permission", decision: "allow" });
  await s.until(runId, "succeeded");
  expect(s.calls).toEqual([["create_repository", { name: "acme" }]]);
  expect(lastTool(s.model.inputs[1]!.items)).toMatchObject({ result: "created", isError: false });
  // The model was offered both actions with their schemas, next to Dispand's own tools; the secret went to the tool only.
  const offered = s.model.inputs[0]!.tools;
  expect(offered.map((t) => t.name)).toEqual(expect.arrayContaining(["GitHub_create_repository", "GitHub_list_repos", "rows_list"]));
  expect(offered.find((t) => t.name === "GitHub_create_repository")).toMatchObject({ description: "Create a repository", inputSchema: { required: ["name"] } });
  expect(s.server.requests.some((h) => h.authorization === SECRET)).toBe(true);
  expect(JSON.stringify(s.model.inputs)).not.toContain("s3cret");
});

test("a file a cloud Job's tool returns is kept for the Job, and the model gets its id", async () => {
  const s = await setup([use("GitHub_get_logo", {}), say("Got it.")]);
  const runId = await s.start();
  await s.until(runId, "succeeded");
  const [kept] = await s.context.db.select().from(attachments).where(eq(attachments.jobId, runId));
  expect(kept).toMatchObject({ mime: "image/png", image: true, tableId: null });
  const result = lastTool(s.model.inputs[1]!.items);
  expect(result.isError).toBe(false);
  expect(result.result).toContain(`attachment ${kept!.id}, image/png`);
});

test("a call the owner denies doesn't reach the tool", async () => {
  const s = await setup([use("GitHub_create_repository", { name: "acme" }), say("Not allowed.")]);
  const runId = await s.start();
  const q = await s.pending(runId);
  await s.engine.answer(q.id, { kind: "permission", decision: "deny" });
  await s.until(runId, "succeeded");
  expect(s.calls).toEqual([]);
  expect(lastTool(s.model.inputs[1]!.items).isError).toBe(true);
});

test("a tool removed from the agent, or an action gone since, is refused without a call", async () => {
  const s = await setup([use("GitHub_create_repository", { name: "acme" }), say("Gone.")]);
  const runId = await s.start();
  const q = await s.pending(runId);
  // Allowed, but the tool was taken back from the agent meanwhile.
  await call(router.agents.update, { ...s.fields, id: s.agent.id, toolIds: [] }, { context: s.context });
  await s.engine.answer(q.id, { kind: "permission", decision: "allow" });
  await s.until(runId, "succeeded");
  expect(s.calls).toEqual([]);
  expect(lastTool(s.model.inputs[1]!.items)).toMatchObject({ isError: true });

  // An action the tool no longer lists, and arguments that aren't an object.
  const gone = await setup([use("GitHub_list_repos", {}), say("Gone.")]);
  const second = await gone.start();
  const asked = await gone.pending(second);
  await gone.context.db.update(toolsTable).set({ actions: [] }).where(eq(toolsTable.id, gone.tool.id));
  await gone.engine.answer(asked.id, { kind: "permission", decision: "allow" });
  await gone.until(second, "succeeded");
  expect(gone.calls).toEqual([]);
});

test("a workflow step's cloud session gets its agent's HTTP tools, and none of Dispand's own", async () => {
  const s = await setup([say("Here.")]);
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
  expect(s.model.inputs[0]!.tools.map((t) => t.name)).toEqual(["ask_user", "submit_outputs", "request_approval", "GitHub_create_repository", "GitHub_list_repos", "GitHub_get_logo"]);
});

test("Dispand's own tools run unasked next to the agent's, which ask", async () => {
  const s = await setup([use("tables_list", {}), use("GitHub_list_repos", {}, "c2"), say("Done.")]);
  const runId = await s.start();
  const q = await s.pending(runId);
  // Only the agent's tool asked: Dispand's own already ran.
  expect(q.payload).toMatchObject({ toolName: "GitHub list_repos" });
  expect(await s.context.db.select().from(questions)).toHaveLength(1);
  await s.engine.answer(q.id, { kind: "permission", decision: "allow" });
  await s.until(runId, "succeeded");
  expect(s.calls).toEqual([["list_repos", {}]]);
});

test("an approval is for the tool it was asked about: it never moves to another tool that takes its name", async () => {
  const s = await setup([use("GitHub_list_repos", {}), say("Gone.")]);
  // A second tool whose name gives the same model-facing names once the first is gone.
  const other: string[] = [];
  const twin = await startFakeMcp([{ name: "list_repos", description: "List", inputSchema: { type: "object", properties: {} }, call: () => (other.push("called"), { content: [{ type: "text", text: "theirs" }] }) }]);
  servers.push(twin);
  const second = await call(router.tools.create, { name: "GitHub!", url: twin.url, transport: "streamable-http", headers: {} }, { context: s.context });
  await call(router.agents.update, { ...s.fields, id: s.agent.id, toolIds: [s.tool.id, second.id] }, { context: s.context });
  const runId = await s.start();
  const q = await s.pending(runId);
  expect(q.payload).toMatchObject({ toolName: "GitHub list_repos" });
  // The tool asked about is taken back: "GitHub_list_repos" now names the other tool's action.
  await call(router.agents.update, { ...s.fields, id: s.agent.id, toolIds: [second.id] }, { context: s.context });
  await s.engine.answer(q.id, { kind: "permission", decision: "allow-always" });
  await s.until(runId, "succeeded");
  expect(s.calls).toEqual([]);
  expect(other).toEqual([]);
  expect(lastTool(s.model.inputs[1]!.items)).toMatchObject({ isError: true });
});

test("an action the owner took off the asking ones runs unasked; the others still ask", async () => {
  const s = await setup([use("GitHub_list_repos", {}), use("GitHub_create_repository", { name: "acme" }, "c2"), say("Done.")]);
  await call(router.agents.setToolAsk, { agentId: s.agent.id, toolId: s.tool.id, action: "list_repos", ask: false }, { context: s.context });
  const runId = await s.start();
  const q = await s.pending(runId);
  // Only the flagged action asked: the other already ran.
  expect(q.payload).toMatchObject({ toolName: "GitHub create_repository" });
  expect(await s.context.db.select().from(questions)).toHaveLength(1);
  expect(s.calls).toEqual([["list_repos", {}]]);
  await s.engine.answer(q.id, { kind: "permission", decision: "allow" });
  await s.until(runId, "succeeded");
  expect(s.calls).toEqual([["list_repos", {}], ["create_repository", { name: "acme" }]]);
});

test("always allow takes the action off the asking ones on the agent; put back, it asks again in the same session", async () => {
  // Before the model's third call, the owner puts the action back among the asking ones.
  let ask: (value: boolean) => Promise<unknown> = async () => undefined;
  const back: Script = async (input) => {
    await ask(true);
    return use("GitHub_list_repos", {}, "c3")(input);
  };
  const s = await setup([use("GitHub_list_repos", {}), use("GitHub_list_repos", {}, "c2"), back, say("Done.")]);
  ask = (value) => call(router.agents.setToolAsk, { agentId: s.agent.id, toolId: s.tool.id, action: "list_repos", ask: value }, { context: s.context });
  const asks = async () => (await call(router.agents.toolAsk, { id: s.agent.id }, { context: s.context }))[0]!.actions.find((a) => a.name === "list_repos")!.ask;
  const runId = await s.start();
  const first = await s.pending(runId);
  expect(first.payload).toMatchObject({ canAlwaysAllow: true });
  await s.engine.answer(first.id, { kind: "permission", decision: "allow-always" });
  // The second call ran unasked, the third asks again.
  const third = await vi.waitFor(async () => {
    const all = await s.context.db.select().from(questions).where(eq(questions.runId, runId));
    const q = all.find((x) => x.status === "pending");
    if (!q) throw new Error("no new question yet");
    return q;
  });
  expect(third.id).not.toBe(first.id);
  expect(s.calls).toEqual([["list_repos", {}], ["list_repos", {}]]);
  expect(await asks()).toBe(true);
});
