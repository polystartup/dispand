import { call } from "@orpc/server";
import { stopTelemetry } from "../telemetry/index.ts";
import { captureTelemetry } from "../telemetry/testing.ts";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { cloudSessions, harnesses, messages, questions, roots, runs, stepRuns } from "../db/schema.ts";
import { createEngine } from "../engine/cli-harness.ts";
import type { Engine } from "../engine/engine.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import type { WorkflowDef } from "../workflows/model.ts";
import { TEXTS } from "./builtins.ts";
import { type ChatItem, createModelClient } from "./model-client.ts";
import { fakeModel, say, use, type Script } from "./test-model.ts";
import { textStream, type ToolCaller } from "./runner.ts";

/** Two MCP-like tools; `hold` keeps calls of `create_repo` running. */
function fakeTools(hold = false) {
  const calls: [string, unknown][] = [];
  const unasked = new Set<string>();
  const spec = (key: string, label: string, description: string) => ({ key, label, spec: { name: "", description, inputSchema: { type: "object" } }, always: true as const, ...(unasked.has(key) ? { ask: false as const } : {}) });
  const tools: ToolCaller = {
    specs: async () => [spec("t1:create_repo", "GitHub create_repo", "Create a repository"), spec("t1:list_repos", "GitHub list_repos", "List repositories")],
    call: async (_session, key, args) => {
      calls.push([key, args]);
      if (hold && key === "t1:create_repo") await new Promise(() => {});
      return { text: `ran ${key}`, isError: false };
    },
    allowAlways: async (_session, key) => void unasked.add(key),
  };
  return { tools, calls };
}

const lastTool = (items: ChatItem[]) => items.findLast((i) => i.role === "tool") as Extract<ChatItem, { role: "tool" }>;

const buttonStep = (agentId: string): WorkflowDef => ({
  trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } },
  steps: [{ id: "n_note", key: "note", type: "agent", name: "Note", agentId, prompt: "Write a note." }],
  edges: [{ from: "n_go", to: "n_note" }],
});

const chat = (agentId: string): WorkflowDef => ({
  trigger: { type: "manual", field: { id: "n_chat", key: "brief", type: "chat", label: "Brief", agentId, prompt: "Ask what to build." } },
  steps: [{ id: "n_plan", key: "plan", type: "agent", name: "Plan", agentId, prompt: "Plan {{brief.idea}}." }],
  edges: [{ from: "n_chat", to: "n_plan" }],
});

/** A button, a step that must give `idea`, and a step using it. */
const stepWithOutputs = (agentId: string): WorkflowDef => ({
  trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } },
  steps: [
    { id: "n_think", key: "think", type: "agent", name: "Think", agentId, prompt: "Find an idea." },
    { id: "n_use", key: "use", type: "agent", name: "Use", agentId, prompt: "Use {{think.idea}}." },
  ],
  edges: [
    { from: "n_go", to: "n_think" },
    { from: "n_think", to: "n_use" },
  ],
});

async function setup(def: (agentId: string) => WorkflowDef, deps: Parameters<typeof createEngine>[4], harnessInput?: Record<string, unknown>) {
  const context = await ownerContext();
  const harness = await call(
    router.harnesses.create,
    (harnessInput ?? { type: "cloud", name: "API", kind: "openai-compatible", baseUrl: "https://llm.test/v1", model: "m", systemPrompt: "You work for Dispand." }) as never,
    { context },
  );
  const agent = await call(router.agents.create, { name: "Writer", harnessId: harness.id, systemPrompt: "Be brief." }, { context });
  const workflow = await call(router.workflows.create, { name: "Ship" }, { context });
  await call(router.workflows.update, { id: workflow.id, name: "Ship", def: def(agent.id) }, { context });
  const engine = createEngine(context.db, context.hub, context.secrets, context.dataEvents, deps);
  onTestFinished(() => engine.stop());
  return { context, engine, workflow, agent, harness };
}

async function stepOf(engine: Engine, runId: string, nodeId: string) {
  const steps = await engine.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
  return steps.find((s) => s.nodeId === nodeId)!;
}

async function pendingQuestion(engine: Engine, runId: string) {
  return vi.waitFor(async () => {
    const [q] = await engine.db.select().from(questions).where(eq(questions.runId, runId));
    if (q?.status !== "pending") throw new Error("no pending question yet");
    return q;
  });
}

const runStatus = async (engine: Engine, runId: string) => (await engine.db.select().from(runs).where(eq(runs.id, runId)))[0]!;
const until = async (engine: Engine, runId: string, status: string) =>
  vi.waitFor(async () => {
    const run = await runStatus(engine, runId);
    if (run.status !== status) throw new Error(`run is ${run.status}`);
    return run;
  });

test("a step's text and result reach the engine, with both system prompts", async () => {
  const model = fakeModel(say("Here is the note."));
  const { engine, workflow } = await setup(buttonStep, { client: model.client });
  const runId = await engine.startRun(workflow.id);
  await until(engine, runId, "succeeded");
  const step = await stepOf(engine, runId, "n_note");
  expect(step).toMatchObject({ status: "succeeded", outputs: { result: "Here is the note." }, runnerId: "cloud", cliSessionId: step.sessionId });
  const transcript = await engine.db.select().from(messages).where(eq(messages.stepRunId, step.id));
  expect(transcript.map((m) => [m.role, m.text])).toEqual([["assistant", "Here is the note."]]);
  expect(model.inputs[0]!.system).toBe("You work for Dispand.\n\nBe brief.");
  expect(model.inputs[0]!.items).toEqual([{ role: "user", text: "Write a note." }]);
  expect(model.inputs[0]!.tools.map((t) => t.name)).toEqual(["ask_user", "submit_outputs", "request_approval"]);
});

test("ask_user becomes a choice question and the answer resumes the loop", async () => {
  const questionsAsked = { questions: [{ question: "Which stack?", header: "Stack", options: [{ label: "Node", description: "" }, { label: "Go", description: "Fast" }], multiSelect: false }] };
  const model = fakeModel(use("ask_user", questionsAsked), say("Node it is."));
  const { engine, workflow } = await setup(buttonStep, { client: model.client });
  const runId = await engine.startRun(workflow.id);
  const q = await pendingQuestion(engine, runId);
  expect(q.payload).toEqual({ kind: "choice", questions: [{ question: "Which stack?", header: "Stack", options: [{ label: "Node" }, { label: "Go", description: "Fast" }], multiSelect: false }] });
  expect(q.placement).toBe("notifications");
  expect((await runStatus(engine, runId)).status).toBe("waiting");
  await engine.answer(q.id, { kind: "choice", answers: { "Which stack?": "Node" } });
  await until(engine, runId, "succeeded");
  expect(lastTool(model.inputs[1]!.items)).toMatchObject({ callId: "call_ask_user", result: "The owner answered: “Which stack?”: Node.", isError: false });
  const step = await stepOf(engine, runId, "n_note");
  const transcript = await engine.db.select().from(messages).where(eq(messages.stepRunId, step.id));
  expect(transcript.map((m) => [m.role, m.text])).toEqual([
    ["tool", "ask_user"],
    ["assistant", "Node it is."],
  ]);
});

test("submit_outputs in a chat asks confirm-outputs, then emits outputs-accepted", async () => {
  const model = fakeModel(say("What shall we build?"), use("submit_outputs", { idea: "a chat app" }), say("The plan."));
  const { engine, workflow } = await setup(chat, { client: model.client });
  const runId = await engine.startRun(workflow.id);
  await vi.waitFor(async () => {
    const [s] = await engine.db.select().from(cloudSessions);
    if (s?.status !== "idle") throw new Error("turn not ended");
  });
  await engine.sendChat(runId, "A chat app");
  const q = await pendingQuestion(engine, runId);
  expect(q).toMatchObject({ placement: "chat", payload: { kind: "confirm-outputs", values: { idea: "a chat app" } } });
  expect(model.inputs[1]!.items.at(-1)).toEqual({ role: "user", text: "A chat app" });
  await engine.answer(q.id, { kind: "confirm-outputs", confirmed: true });
  await until(engine, runId, "succeeded");
  expect((await stepOf(engine, runId, "n_chat")).outputs).toEqual({ idea: "a chat app" });
  // The chat ended with the confirmation: the third call is the next step's.
  expect(model.inputs).toHaveLength(3);
  expect(model.inputs[2]!.items).toEqual([{ role: "user", text: "Plan a chat app." }]);
});

test("a chat's unconfirmed outputs go back to the model with the feedback", async () => {
  const model = fakeModel(use("submit_outputs", { idea: "x" }), say("Tell me more."));
  const { engine, workflow } = await setup(chat, { client: model.client });
  const runId = await engine.startRun(workflow.id);
  const q = await pendingQuestion(engine, runId);
  await engine.answer(q.id, { kind: "confirm-outputs", confirmed: false, feedback: "Not x." });
  await vi.waitFor(() => expect(model.inputs).toHaveLength(2));
  expect(lastTool(model.inputs[1]!.items)).toMatchObject({ result: "Not x." });
});

test("reminds once then fails", async () => {
  const model = fakeModel(say("Thinking."), say("Still thinking."));
  const { engine, workflow } = await setup(stepWithOutputs, { client: model.client });
  const runId = await engine.startRun(workflow.id);
  const run = await until(engine, runId, "failed");
  expect(run.error).toBe("the agent finished without its outputs");
  expect(model.inputs[1]!.items.at(-1)).toEqual({ role: "user", text: "Call submit_outputs with: idea" });
});

test("submit_outputs outside a chat completes the step at once; missing values are asked again", async () => {
  const model = fakeModel(use("submit_outputs", {}, "c1"), use("submit_outputs", { idea: "boats" }, "c2"), say("Used."));
  const { engine, workflow } = await setup(stepWithOutputs, { client: model.client });
  const runId = await engine.startRun(workflow.id);
  await until(engine, runId, "succeeded");
  expect((await stepOf(engine, runId, "n_think")).outputs).toEqual({ idea: "boats" });
  expect(lastTool(model.inputs[1]!.items)).toMatchObject({ result: "Missing outputs: idea. Call submit_outputs again with every value, as text.", isError: true });
});

test("a denied tool call returns an error result to the model", async () => {
  const { tools, calls } = fakeTools();
  const model = fakeModel(use("GitHub_create_repo", { name: "x" }), say("Understood."));
  const { engine, workflow } = await setup(buttonStep, { client: model.client, tools });
  const runId = await engine.startRun(workflow.id);
  const q = await pendingQuestion(engine, runId);
  expect(q.payload).toEqual({ kind: "permission", toolName: "GitHub create_repo", input: { name: "x" }, canAlwaysAllow: true });
  await engine.answer(q.id, { kind: "permission", decision: "deny", message: "Not today." });
  await until(engine, runId, "succeeded");
  expect(calls).toEqual([]);
  expect(lastTool(model.inputs[1]!.items)).toMatchObject({ callId: "call_GitHub_create_repo", result: "Not today.", isError: true });
  expect(model.inputs[0]!.tools.map((t) => t.name)).toEqual(["ask_user", "submit_outputs", "request_approval", "GitHub_create_repo", "GitHub_list_repos"]);
});

test("always allow skips the next question for that tool only", async () => {
  const { tools, calls } = fakeTools();
  const model = fakeModel(
    use("GitHub_list_repos", {}, "a"),
    use("GitHub_list_repos", { page: 2 }, "b"),
    use("GitHub_create_repo", { name: "x" }, "c"),
    say("Done."),
  );
  const { engine, workflow } = await setup(buttonStep, { client: model.client, tools });
  const runId = await engine.startRun(workflow.id);
  const first = await pendingQuestion(engine, runId);
  await engine.answer(first.id, { kind: "permission", decision: "allow-always" });
  // The second list_repos runs without a question; create_repo asks.
  const second = await vi.waitFor(async () => {
    const qs = await engine.db.select().from(questions).where(eq(questions.runId, runId));
    const q = qs.find((x) => x.status === "pending");
    if (!q) throw new Error("no second question");
    return q;
  });
  expect(second.payload).toMatchObject({ kind: "permission", toolName: "GitHub create_repo" });
  expect(calls).toEqual([
    ["t1:list_repos", {}],
    ["t1:list_repos", { page: 2 }],
  ]);
  await engine.answer(second.id, { kind: "permission", decision: "allow" });
  await until(engine, runId, "succeeded");
  expect(calls).toHaveLength(3);
  expect(lastTool(model.inputs[3]!.items)).toMatchObject({ callId: "c", result: "ran t1:create_repo", isError: false });
});

test("restart mid tool call does not rerun it", async () => {
  const held = fakeTools(true);
  const model = fakeModel(use("GitHub_create_repo", { name: "x" }, "c1"));
  const { context, engine, workflow } = await setup(buttonStep, { client: model.client, tools: held.tools });
  const runId = await engine.startRun(workflow.id);
  const q = await pendingQuestion(engine, runId);
  await engine.answer(q.id, { kind: "permission", decision: "allow" });
  await vi.waitFor(async () => {
    const [s] = await engine.db.select().from(cloudSessions);
    if (!s?.inFlight) throw new Error("not in flight yet");
  });
  expect(held.calls).toHaveLength(1);

  // Dispand restarts: a new engine and cloud runner over the same database.
  const after = fakeModel(say("I'll check whether it exists."));
  const fresh = fakeTools();
  const engine2 = createEngine(context.db, context.hub, context.secrets, context.dataEvents, { client: after.client, tools: fresh.tools });
  onTestFinished(() => engine2.stop());
  await engine2.recover();
  await until(engine2, runId, "succeeded");
  expect(held.calls).toHaveLength(1);
  expect(fresh.calls).toEqual([]);
  expect(lastTool(after.inputs[0]!.items)).toEqual({ role: "tool", callId: "c1", name: "GitHub_create_repo", result: TEXTS.restarted, isError: true });
});

test("on boot, a cloud turn of a root paused at a checkpoint isn't run again until the root goes on", async () => {
  const held = fakeTools(true);
  const model = fakeModel(use("GitHub_create_repo", { name: "x" }, "c1"));
  const { context, engine, workflow } = await setup(buttonStep, { client: model.client, tools: held.tools });
  const runId = await engine.startRun(workflow.id);
  const q = await pendingQuestion(engine, runId);
  await engine.answer(q.id, { kind: "permission", decision: "allow" });
  await vi.waitFor(async () => {
    const [s] = await engine.db.select().from(cloudSessions);
    if (!s?.inFlight) throw new Error("not in flight yet");
  });
  // Its root is paused at a checkpoint when Dispand restarts.
  await engine.db.insert(roots).values({ id: "root_1", ownerId: context.ownerId, kind: "user", state: "paused" });
  await engine.db.update(runs).set({ rootId: "root_1" }).where(eq(runs.id, runId));
  const after = fakeModel(say("Done."));
  const engine2 = createEngine(context.db, context.hub, context.secrets, context.dataEvents, { client: after.client, tools: fakeTools().tools });
  onTestFinished(() => engine2.stop());
  await engine2.recover();
  await new Promise((r) => setTimeout(r, 100));
  // Nothing of it ran: no model call, and no question asked again. The call the restart cut is
  // recorded as cut all the same, so it never runs again by itself.
  expect(after.inputs).toEqual([]);
  const [session] = await engine2.db.select().from(cloudSessions);
  expect(session!.inFlight).toBeNull();
  expect(lastTool(session!.items)).toMatchObject({ callId: "c1", result: TEXTS.restarted, isError: true });
  expect(await engine2.db.select().from(questions)).toHaveLength(1);
  expect(await stepOf(engine2, runId, "n_note")).toMatchObject({ working: false, pendingAction: { kind: "resume" } });
  // The root went on (its answer committed) before the next start: that start hands it back, and
  // the session goes on from the cut call, which it doesn't make again.
  await engine.db.update(roots).set({ state: "going" }).where(eq(roots.id, "root_1"));
  const engine3 = createEngine(context.db, context.hub, context.secrets, context.dataEvents, { client: after.client, tools: fakeTools().tools });
  onTestFinished(() => engine3.stop());
  await engine3.recover();
  await until(engine3, runId, "succeeded");
  expect(after.inputs).toHaveLength(1);
  expect(lastTool(after.inputs[0]!.items)).toMatchObject({ callId: "c1", result: TEXTS.restarted, isError: true });
});

test("on boot, the last event is handed to the engine again", async () => {
  const model = fakeModel(say("Done."));
  const { context, engine, workflow } = await setup(buttonStep, { client: model.client });
  const runId = await engine.startRun(workflow.id);
  await until(engine, runId, "succeeded");
  // The result was written but the engine never got it (the server stopped in between).
  const step = await stepOf(engine, runId, "n_note");
  await engine.db.update(stepRuns).set({ status: "running", outputs: null, finishedAt: null, eventSeq: 0 }).where(eq(stepRuns.id, step.id));
  await engine.db.update(runs).set({ status: "running", finishedAt: null }).where(eq(runs.id, runId));
  const engine2 = createEngine(context.db, context.hub, context.secrets, context.dataEvents, { client: fakeModel().client });
  onTestFinished(() => engine2.stop());
  await engine2.recover();
  expect(await stepOf(engine2, runId, "n_note")).toMatchObject({ status: "succeeded", outputs: { result: "Done." } });
});

test("a provider error fails the step with a short message", async () => {
  const key = "sk-very-secret-key-123456";
  const fetch = (async () =>
    new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${key}` } }), { status: 401, headers: { "content-type": "application/json" } })) as typeof globalThis.fetch;
  const { engine, workflow } = await setup(
    buttonStep,
    { client: (h) => createModelClient(h, { fetch }) },
    { type: "cloud", name: "API", kind: "openai-compatible", baseUrl: "https://llm.test/v1", apiKey: key, model: "m", systemPrompt: "" },
  );
  const runId = await engine.startRun(workflow.id);
  const run = await until(engine, runId, "failed");
  expect(run.error).toBe("The provider refused the key");
  const dump = JSON.stringify([
    await engine.db.select().from(stepRuns),
    await engine.db.select().from(messages),
    await engine.db.select().from(cloudSessions),
    run,
  ]);
  expect(dump).not.toContain(key);
});

test("the agent's model overrides the harness's for cloud sessions", async () => {
  const model = fakeModel(say("ok"));
  const { context, engine, workflow, agent } = await setup(buttonStep, { client: model.client });
  await call(router.agents.update, { ...agent, model: "bigger" }, { context });
  const runId = await engine.startRun(workflow.id);
  await until(engine, runId, "succeeded");
  expect(model.harnesses[0]!.model).toBe("bigger");
});

test("too many model calls in one turn fail the step", async () => {
  const loop: Script[] = Array.from({ length: 60 }, (_, i) => use("ask_user", { questions: [] }, `c${i}`));
  const model = fakeModel(...loop);
  const { engine, workflow } = await setup(buttonStep, { client: model.client });
  const runId = await engine.startRun(workflow.id);
  const run = await until(engine, runId, "failed");
  expect(run.error).toBe("the agent made too many tool calls in one turn");
  expect(model.inputs).toHaveLength(50);
});

test("an empty text delta doesn't stall the session", async () => {
  const model = fakeModel((input) => {
    input.onText("");
    return { text: "Done." };
  });
  const { engine, workflow } = await setup(buttonStep, { client: model.client });
  const runId = await engine.startRun(workflow.id);
  await until(engine, runId, "succeeded");
});

test("text pushed while a delta is being written goes out too", async () => {
  const sent: string[] = [];
  const stream = textStream(async (d) => void sent.push(d));
  stream.push("a");
  await Promise.resolve();
  stream.push("b");
  await Promise.resolve();
  await Promise.resolve();
  stream.push("c");
  await stream.done();
  expect(sent.join("")).toBe("abc");
});

test("stopping a run whose cloud session waits for an answer ends the session: no model call follows", async () => {
  const questionsAsked = { questions: [{ question: "Which stack?", header: "Stack", options: [{ label: "Node", description: "" }, { label: "Go", description: "" }], multiSelect: false }] };
  const model = fakeModel(use("ask_user", questionsAsked), say("Node it is."));
  const { engine, workflow } = await setup(buttonStep, { client: model.client });
  const runId = await engine.startRun(workflow.id);
  const q = await pendingQuestion(engine, runId);
  await engine.stopRun(runId);
  const step = await stepOf(engine, runId, "n_note");
  await vi.waitFor(async () => {
    const [session] = await engine.db.select().from(cloudSessions).where(eq(cloudSessions.id, step.sessionId!));
    expect(session!.status).toBe("done");
  });
  // A late answer finds the question expired, and the model is never called again.
  await expect(engine.answer(q.id, { kind: "choice", answers: { "Which stack?": "Node" } })).rejects.toThrow();
  expect(model.inputs).toHaveLength(1);
  expect(await runStatus(engine, runId)).toMatchObject({ status: "failed", error: "Stopped" });
});

test("request_approval asks the owner and tells the model the answer", async () => {
  const model = fakeModel(use("request_approval", { message: "Send this draft to the client?" }), say("Sent."));
  const { engine, workflow } = await setup(buttonStep, { client: model.client });
  const runId = await engine.startRun(workflow.id);
  const q = await pendingQuestion(engine, runId);
  expect(q.payload).toEqual({ kind: "permission", toolName: "request_approval", input: { message: "Send this draft to the client?" }, canAlwaysAllow: false });
  expect(q.kind).toBe("approval");
  expect(model.inputs.at(0)!.tools.map((t) => t.name)).toEqual(["ask_user", "submit_outputs", "request_approval"]);
  await engine.answer(q.id, { kind: "permission", decision: "allow" });
  await until(engine, runId, "succeeded");
  expect(lastTool(model.inputs[1]!.items)).toMatchObject({ callId: "call_request_approval", result: "Approved.", isError: false });
});

test("request_approval denied gives the model the owner's words, and asks again the next time", async () => {
  const model = fakeModel(use("request_approval", { message: "Delete the folder?" }), use("request_approval", { message: "Archive it instead?" }, "c2"), say("Archived."));
  const { engine, workflow } = await setup(buttonStep, { client: model.client });
  const runId = await engine.startRun(workflow.id);
  const first = await pendingQuestion(engine, runId);
  await engine.answer(first.id, { kind: "permission", decision: "deny", message: "Never delete." });
  expect(lastTool((await vi.waitFor(() => (model.inputs[1] ? model.inputs[1] : Promise.reject(new Error("no second turn"))))).items)).toMatchObject({ result: "Denied: Never delete.", isError: true });
  // An approval is for one request: the next one waits for its own answer.
  const second = await vi.waitFor(async () => {
    const rows = await engine.db.select().from(questions).where(eq(questions.runId, runId));
    const q = rows.find((r) => r.status === "pending");
    if (!q) throw new Error("no second question yet");
    return q;
  });
  expect(second.payload).toMatchObject({ input: { message: "Archive it instead?" } });
  await engine.answer(second.id, { kind: "permission", decision: "allow" });
  await until(engine, runId, "succeeded");
});

test("request_approval without words, or with too many, is refused without a question", async () => {
  const model = fakeModel(use("request_approval", { message: "  " }), use("request_approval", { message: "x".repeat(4001) }, "c2"), use("request_approval", {}, "c3"), say("Fine."));
  const { engine, workflow } = await setup(buttonStep, { client: model.client });
  const runId = await engine.startRun(workflow.id);
  await until(engine, runId, "succeeded");
  expect(await engine.db.select().from(questions).where(eq(questions.runId, runId))).toEqual([]);
  expect(lastTool(model.inputs[1]!.items).isError).toBe(true);
  expect(lastTool(model.inputs[3]!.items).isError).toBe(true);
});

test("a model call is a span with the harness's kind, how the turn ended and how many tools it asked for, never the prompt or the answer", async () => {
  const model = fakeModel(say("sentinel-model-answer"));
  const { engine, workflow } = await setup(buttonStep, { client: model.client });
  const t = await captureTelemetry();
  onTestFinished(() => stopTelemetry());
  const runId = await engine.startRun(workflow.id);
  await until(engine, runId, "succeeded");
  const [span] = t.spans().filter((x) => x.name === "model.turn");
  expect(span!.attributes).toMatchObject({ "dispand.harness.kind": "openai-compatible", "dispand.result": "end", "dispand.model.tool_calls": 0 });
  expect(await t.metrics()).toContainEqual({ name: "dispand.model.calls", attributes: { "dispand.harness.kind": "openai-compatible", "dispand.result": "end" } });
  const all = await t.all();
  for (const sentinel of ["sentinel-model-answer", "You work for Dispand.", "Be brief."]) expect(all).not.toContain(sentinel);
});

test("a chat with no instructions makes no model call until the owner writes: the first message is the first turn", async () => {
  const model = fakeModel(say("Hello there."));
  const noInstructions = (agentId: string): WorkflowDef => {
    const def = chat(agentId);
    return { ...def, trigger: { ...def.trigger, field: { ...def.trigger.field, prompt: "" } } as WorkflowDef["trigger"] };
  };
  const { engine, workflow } = await setup(noInstructions, { client: model.client });
  const runId = await engine.startRun(workflow.id);
  await vi.waitFor(async () => {
    const [s] = await engine.db.select().from(cloudSessions);
    if (s?.status !== "idle") throw new Error("not waiting yet");
  });
  // Waiting for the owner, it holds no slot.
  expect((await stepOf(engine, runId, "n_chat")).working).toBe(false);
  expect(model.inputs).toHaveLength(0);
  await engine.sendChat(runId, "Hi");
  await vi.waitFor(() => expect(model.inputs).toHaveLength(1));
  expect(model.inputs[0]!.items).toEqual([{ role: "user", text: "Hi" }]);
});

test("a cloud session holds its harness's slot only while it works: not between chat turns, nor while it asks", async () => {
  const model = fakeModel(say("What shall we build?"), use("ask_user", { questions: [{ question: "Which stack?", header: "Stack", options: [{ label: "Node", description: "" }], multiSelect: false }] }), say("Done."));
  const { context, engine, workflow, agent, harness } = await setup(chat, { client: model.client });
  await context.db.update(harnesses).set({ maxWorking: 1 }).where(eq(harnesses.id, harness.id));
  const working = async (runId: string, nodeId: string) => (await stepOf(engine, runId, nodeId)).working;
  const chatRun = await engine.startRun(workflow.id);
  await vi.waitFor(async () => {
    const [s] = await engine.db.select().from(cloudSessions);
    if (s?.status !== "idle") throw new Error("turn not ended");
  });
  // Between turns, the chat holds no slot: the next run starts on the only one.
  expect(await working(chatRun, "n_chat")).toBe(false);
  const note = await call(router.workflows.create, { name: "Note" }, { context });
  await call(router.workflows.update, { id: note.id, name: "Note", def: buttonStep(agent.id) }, { context });
  const noteRun = await engine.startRun(note.id);
  const q = await pendingQuestion(engine, noteRun);
  // Asking, it gives the slot back; its answer takes one again, and the loop goes on.
  expect(await working(noteRun, "n_note")).toBe(false);
  await engine.answer(q.id, { kind: "choice", answers: { "Which stack?": "Node" } });
  await until(engine, noteRun, "succeeded");
  expect(await working(noteRun, "n_note")).toBe(false);
  expect(model.inputs).toHaveLength(3);
});
