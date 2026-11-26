import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { chatQueue, harnesses, messages, personalGrants, runs, stepRuns, tools } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext, runnerWithClis } from "../runners/test-support.ts";
import type { ToolExecutor } from "../tools/executor.ts";
import type { ToolStep, WorkflowDef } from "../workflows/model.ts";
import { Engine } from "./engine.ts";
import { TOOL_RESTARTED } from "./errors.ts";
import type { Harness, HarnessAdapter, StartParams } from "./harness.ts";
import type { Place, PlaceGate, PlaceWork } from "./places.ts";

// The engine asks its gate before working on a step's place, and a refusal writes nothing: what
// the work would have sent stays owed in its rows. Without a gate (every other test) nothing is asked.

class FakeAdapter implements HarnessAdapter {
  starts: StartParams[] = [];
  sent: string[] = [];
  steers: string[] = [];
  stops: string[] = [];
  async start(_harness: Harness, start: StartParams) {
    this.starts.push(start);
    return true;
  }
  async send(_sessionId: string, text: string) {
    this.sent.push(text);
    return true;
  }
  async steer(_sessionId: string, _turnId: string, _requestId: string, text: string) {
    this.steers.push(text);
    return true;
  }
  async answer() {
    return true;
  }
  async stop(sessionId: string) {
    this.stops.push(sessionId);
    return true;
  }
}

/** Refuses the work `refuses` names, on the places `on` picks (every place by default); records each ask. */
class FakeGate implements PlaceGate {
  asked: [PlaceWork, Place][] = [];
  refuses = new Set<PlaceWork>();
  on: (place: Place) => boolean = () => true;
  admits(work: PlaceWork, place: Place) {
    this.asked.push([work, place]);
    return !(this.refuses.has(work) && this.on(place));
  }
  drives() {
    return true;
  }
  carry = { interrupt: async () => "failed" as const, steer: async () => false, stop: async () => false };
}

/** A Tool step call that settles only when it is cut. */
class PendingTools implements ToolExecutor {
  calls = 0;
  signals: AbortSignal[] = [];
  run(_workspaceId: string, _step: ToolStep, _values: unknown, signal: AbortSignal): ReturnType<ToolExecutor["run"]> {
    this.calls++;
    this.signals.push(signal);
    return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, error: "cancelled" })));
  }
}

const chat = (agentId: string): WorkflowDef => ({
  trigger: { type: "manual", field: { id: "n_chat", key: "brief", type: "chat", label: "Brief", agentId, prompt: "Ask what to build." } },
  steps: [],
  edges: [],
});

const button = (agentId: string): WorkflowDef => ({
  trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } },
  steps: [{ id: "n_note", key: "note", type: "agent", name: "Note", agentId, prompt: "Write a note." }],
  edges: [{ from: "n_go", to: "n_note" }],
});

const tool = (): WorkflowDef => ({
  trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } },
  steps: [{ id: "n_repo", key: "create_repo", type: "tool", name: "Create repo", toolId: "tool_gh", action: "create_repository", inputs: [{ param: "name", source: { type: "value", value: "acme" } }] }],
  edges: [{ from: "n_go", to: "n_repo" }],
});

async function setup(def: (agentId: string) => WorkflowDef, maxWorking = 5) {
  const context = await ownerContext();
  const { runnerId } = await runnerWithClis(context);
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "acceptEdits" }, { context }));
  await context.db.update(harnesses).set({ maxWorking }).where(eq(harnesses.id, harness.id));
  const agent = await call(router.agents.create, { name: "Writer", harnessId: harness.id, systemPrompt: "Be brief." }, { context });
  await context.db.insert(tools).values({
    id: "tool_gh",
    ownerId: context.ownerId,
    workspaceId: context.workspaceId,
    name: "GitHub",
    kind: "http",
    url: "https://mcp.example.com/",
    transport: "streamable-http",
    actions: [{ name: "create_repository", description: "", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }],
  });
  const workflow = await call(router.workflows.create, { name: "Ship" }, { context });
  await call(router.workflows.update, { id: workflow.id, name: "Ship", def: def(agent.id) }, { context });
  const adapter = new FakeAdapter();
  const gate = new FakeGate();
  const toolSteps = new PendingTools();
  const engine = new Engine(context.db, adapter, undefined, undefined, toolSteps, undefined, gate);
  onTestFinished(() => engine.stop());
  let seq = 0;
  const emit = (sessionId: string, event: Parameters<Engine["onHarnessEvent"]>[1]) => engine.onHarnessEvent(sessionId, event, { runnerId, seq: ++seq });
  /** The run's one step that isn't a button (its chat, its agent step, its Tool step). */
  const step = async (runId: string) => (await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId))).find((s) => s.nodeId !== "n_go")!;
  return { context, runnerId, workflow, adapter, gate, toolSteps, engine, emit, step };
}

test("a refused launch claims nothing and issues no grant", async () => {
  const { context, runnerId, workflow, adapter, gate, engine, step } = await setup(button);
  gate.refuses.add("launch");
  const runId = await engine.startRun(workflow.id);
  await engine.idle();
  // Its rows say a start is owed: the step runs a session whose start was never written.
  const owed = await step(runId);
  expect(owed).toMatchObject({ status: "running", sessionId: expect.any(String), startDeliveredAt: null });
  expect(adapter.starts).toEqual([]);
  expect(await context.db.select().from(personalGrants).where(eq(personalGrants.stepRunId, owed.id))).toEqual([]);
  expect(gate.asked).toContainEqual(["launch", { stepId: owed.id, sessionId: owed.sessionId }]);
  // Nothing was left claimed: the place's holder sends it once (a reconcile waits for any start under way).
  gate.refuses.clear();
  await engine.reconcile(runnerId, []);
  await engine.idle();
  expect(adapter.starts.map((s) => s.sessionId)).toEqual([owed.sessionId]);
});

test("a refused hand-over leaves pending_action set", async () => {
  const { workflow, adapter, gate, engine, step } = await setup(button, 1);
  const first = await engine.startRun(workflow.id);
  const second = await engine.startRun(workflow.id);
  expect(await step(second)).toMatchObject({ working: false, queuedAt: expect.any(Date) });
  gate.refuses.add("handOver");
  // The first one's slot goes to the second, whose start is then owed to its place's holder.
  await engine.stopRun(first);
  await engine.idle();
  expect(await step(second)).toMatchObject({ working: true, pendingAction: { kind: "start" }, sessionId: null });
  expect(adapter.starts).toHaveLength(1);
  expect(gate.asked.filter(([work]) => work === "handOver")).toHaveLength(1);
});

test("a refused steer leaves its queued item steering", async () => {
  const { context, workflow, adapter, gate, engine, emit } = await setup(chat);
  const runId = await engine.startRun(workflow.id);
  const sessionId = adapter.starts[0]!.sessionId;
  await emit(sessionId, { type: "turn-start", turnId: "first", interruptible: true });
  const { queuedId } = await engine.sendChat(runId, "Now");
  gate.refuses.add("message");
  await engine.steerQueued(runId, queuedId!);
  await engine.idle();
  expect(adapter.steers).toEqual([]);
  expect((await context.db.select().from(chatQueue).where(eq(chatQueue.id, queuedId!)))[0]!.state).toBe("steering");
  // Owed, unclaimed: the holder's next delivery claims it.
  expect((await context.db.select().from(messages).where(eq(messages.id, queuedId!)))[0]).toMatchObject({ deliveredAt: null, delivering: null });
});

test("reconcile skips refused steps without unconfirming them", async () => {
  const { runnerId, workflow, adapter, gate, engine, emit, step } = await setup(chat);
  const kept = await engine.startRun(workflow.id);
  const lost = await engine.startRun(workflow.id);
  const keptStep = await step(kept);
  const lostStep = await step(lost);
  for (const s of [keptStep, lostStep]) await emit(s.sessionId!, { type: "turn-start", turnId: "first", interruptible: true });
  // Another process holds the first one's place: its runner reports neither session, and only the second resumes here.
  gate.refuses.add("reconcile");
  gate.on = (place) => place.stepId === keptStep.id;
  await engine.reconcile(runnerId, []);
  await engine.idle();
  expect(await step(kept)).toMatchObject({ status: "running", turnStatus: "running", turnId: "first", startDeliveredAt: keptStep.startDeliveredAt });
  expect((await step(lost)).turnStatus).toBe("unknown");
  expect(adapter.starts.map((s) => s.sessionId)).toEqual([keptStep.sessionId, lostStep.sessionId, lostStep.sessionId]);
  expect(adapter.stops).toEqual([]);
});

test("recovery fails only the Tool steps whose caller the gate reports gone", async () => {
  const { context, workflow, gate, toolSteps, engine, step } = await setup(tool);
  const live = await engine.startRun(workflow.id);
  const gone = await engine.startRun(workflow.id);
  expect(toolSteps.calls).toBe(2);
  // This process stops: its calls are cut, and both steps are left running.
  await engine.stop();
  const liveStep = await step(live);
  gate.refuses.add("failTool");
  gate.on = (place) => place.stepId === liveStep.id;
  const recovering = new Engine(context.db, new FakeAdapter(), undefined, undefined, toolSteps, undefined, gate);
  onTestFinished(() => recovering.stop());
  await recovering.recover();
  expect((await step(live)).status).toBe("running");
  expect(await step(gone)).toMatchObject({ status: "failed", error: TOOL_RESTARTED });
  expect((await context.db.select({ status: runs.status }).from(runs).where(eq(runs.id, live)))[0]!.status).toBe("running");
  expect(toolSteps.calls).toBe(2);
});

test("a refused Tool step call claims nothing", async () => {
  const { workflow, gate, toolSteps, engine, step } = await setup(tool);
  gate.refuses.add("tool");
  const runId = await engine.startRun(workflow.id);
  await vi.waitFor(() => expect(gate.asked.some(([work]) => work === "tool")).toBe(true));
  expect(toolSteps.calls).toBe(0);
  expect(await step(runId)).toMatchObject({ status: "pending", startedAt: null });
});

// `deliver`: what a place's holder runs for a step another process wrote work for.

test("deliver › a message written after the session's start is sent once", async () => {
  const { context, workflow, adapter, gate, engine, emit, step } = await setup(chat);
  const runId = await engine.startRun(workflow.id);
  const chatStep = await step(runId);
  await emit(chatStep.sessionId!, { type: "turn-start", turnId: "first", interruptible: true });
  await emit(chatStep.sessionId!, { type: "turn-end", turnId: "first" });
  // Another process writes it and is refused its delivery: it stays owed.
  gate.refuses.add("message");
  await engine.sendChat(runId, "Written elsewhere");
  await engine.idle();
  expect(adapter.sent).toEqual([]);
  gate.refuses.clear();
  await engine.deliver(chatStep.id);
  await engine.idle();
  await engine.deliver(chatStep.id);
  await engine.idle();
  expect(adapter.sent).toEqual(["Written elsewhere"]);
  expect((await context.db.select().from(messages).where(eq(messages.runId, runId)))[0]!.deliveredAt).not.toBeNull();
});

test("deliver › a stopped step's session is ended and its Tool call cut", async () => {
  const chatRun = await setup(chat);
  const runId = await chatRun.engine.startRun(chatRun.workflow.id);
  const chatStep = await chatRun.step(runId);
  // Stopped by another process, which reaches neither the session nor the call.
  const elsewhere = new Engine(chatRun.context.db, new FakeAdapter());
  onTestFinished(() => elsewhere.stop());
  await elsewhere.stopRun(runId);
  expect(chatRun.adapter.stops).toEqual([]);
  await chatRun.engine.deliver(chatStep.id);
  await chatRun.engine.idle();
  expect(chatRun.adapter.stops).toEqual([chatStep.sessionId]);

  const toolRun = await setup(tool);
  const toolRunId = await toolRun.engine.startRun(toolRun.workflow.id);
  const toolStep = await toolRun.step(toolRunId);
  const signal = toolRun.toolSteps.signals[0]!;
  const other = new Engine(toolRun.context.db, new FakeAdapter());
  onTestFinished(() => other.stop());
  await other.stopRun(toolRunId);
  expect(signal.aborted).toBe(false);
  await toolRun.engine.deliver(toolStep.id);
  expect(signal.aborted).toBe(true);
});

test("deliver › called twice at once, each row goes once", async () => {
  const { workflow, adapter, gate, engine, emit, step } = await setup(chat);
  const runId = await engine.startRun(workflow.id);
  const chatStep = await step(runId);
  await emit(chatStep.sessionId!, { type: "turn-start", turnId: "first", interruptible: true });
  await emit(chatStep.sessionId!, { type: "turn-end", turnId: "first" });
  gate.refuses.add("message");
  await engine.sendChat(runId, "One");
  await engine.idle();
  gate.refuses.clear();
  await Promise.all([engine.deliver(chatStep.id), engine.deliver(chatStep.id)]);
  await engine.idle();
  expect(adapter.sent).toEqual(["One"]);
});

test("deliver › a slot handed to a queued step whose hand-over was refused starts it", async () => {
  const { workflow, adapter, gate, engine, step } = await setup(button, 1);
  const first = await engine.startRun(workflow.id);
  const second = await engine.startRun(workflow.id);
  gate.refuses.add("handOver");
  await engine.stopRun(first);
  await engine.idle();
  const owed = await step(second);
  expect(owed).toMatchObject({ status: "pending", working: true, pendingAction: { kind: "start" } });
  gate.refuses.clear();
  await engine.deliver(owed.id);
  await engine.idle();
  expect(adapter.starts).toHaveLength(2);
  expect(await step(second)).toMatchObject({ status: "running", pendingAction: null });
});
