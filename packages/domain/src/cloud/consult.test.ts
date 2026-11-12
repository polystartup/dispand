import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { agentConsults, runs, stepRuns } from "../db/schema.ts";
import { createEngine } from "../engine/cli-harness.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import { stopTelemetry } from "../telemetry/index.ts";
import { captureTelemetry } from "../telemetry/testing.ts";
import type { ChatItem, ModelTurn, TurnInput } from "./model-client.ts";

type Turn = (input: TurnInput) => Partial<ModelTurn>;

/** Two cloud agents, Asker and Expert, each with its own scripted model (told apart by its system prompt). */
async function setup(scripts: { asker: Turn[]; expert: Turn[] }, entries = true) {
  const context0 = await ownerContext();
  const seen: { asker: TurnInput[]; expert: TurnInput[] } = { asker: [], expert: [] };
  const client = () => ({
    async turn(input: TurnInput): Promise<ModelTurn> {
      const who = input.system.includes("You are Expert.") ? "expert" : "asker";
      seen[who].push({ ...input, items: structuredClone(input.items) });
      const next = scripts[who].shift();
      if (!next) throw Object.assign(new Error("no turn left"), { status: 500 });
      const t = next(input);
      const toolCalls = t.toolCalls ?? [];
      return { text: t.text ?? "", toolCalls, raw: {}, stop: toolCalls.length ? "tool_use" : "end" };
    },
  });
  const engine = createEngine(context0.db, context0.hub, context0.secrets, context0.dataEvents, { client });
  onTestFinished(() => engine.stop());
  const context = { ...context0, engine };
  const harness = await call(router.harnesses.create, { type: "cloud", name: "API", kind: "openai-compatible", baseUrl: "https://llm.test/v1", model: "m", systemPrompt: "" } as never, { context });
  const expert = await call(router.agents.create, { name: "Expert", description: "Knows the plans", harnessId: harness.id, systemPrompt: "You are Expert." }, { context });
  const asker = await call(router.agents.create, { name: "Asker", harnessId: harness.id, systemPrompt: "You are Asker." }, { context });
  if (entries) await context.db.insert(agentConsults).values({ agentId: asker.id, consultedId: expert.id, ask: false });
  const trigger = await call(router.triggers.create, { agentId: asker.id, name: "Go", instructions: "Find out the plan.", config: { kind: "manual", placement: "button" } }, { context });
  const until = (runId: string, status: string) =>
    vi.waitFor(async () => {
      const [run] = await context.db.select().from(runs).where(eq(runs.id, runId));
      if (run!.status !== status) throw new Error(`run is ${run!.status}`);
      return run!;
    });
  return { context, engine, seen, expert, asker, trigger, until };
}

const lastTool = (items: ChatItem[]) => items.findLast((i) => i.role === "tool") as Extract<ChatItem, { role: "tool" }>;

test("a cloud Job consults an agent listed in its consult tool and goes on with its answer", async () => {
  const ids = { expert: "" };
  const s = await setup({
    asker: [() => ({ toolCalls: [{ id: "c1", name: "consult", args: { agent: ids.expert, question: "Which plan, sentinel-consult-question-41?" } }] }), () => ({ text: "Going with it." })],
    expert: [() => ({ text: "Plan B, sentinel-consult-answer-42." })],
  });
  ids.expert = s.expert.id;
  const telemetry = await captureTelemetry();
  onTestFinished(() => stopTelemetry());
  const { runId } = await call(router.jobs.start, { triggerId: s.trigger.id }, { context: s.context });
  await s.until(runId, "succeeded");
  // The tool lists the agent by id, name and description.
  const tool = s.seen.asker[0]!.tools.find((t) => t.name === "consult")!;
  expect(tool.description).toContain(`${s.expert.id}: Expert (Knows the plans)`);
  // The consulted Job got the question, and nothing of the asker's work.
  const prompt = (s.seen.expert[0]!.items[0] as Extract<ChatItem, { role: "user" }>).text;
  expect(prompt).toContain("Which plan, sentinel-consult-question-41?");
  expect(prompt).not.toContain("Find out the plan.");
  // The asker reads the answer, and who gave it.
  expect(lastTool(s.seen.asker[1]!.items)).toMatchObject({ isError: false, result: "Answer from the agent Expert:\n\nPlan B, sentinel-consult-answer-42." });
  // Counted, and nothing of the question or the answer reached telemetry.
  const metrics = await telemetry.metrics();
  expect(metrics).toContainEqual({ name: "dispand.consults.asked", attributes: {} });
  expect(metrics).toContainEqual({ name: "dispand.consults.ended", attributes: { "dispand.consult.outcome": "answered" } });
  expect(metrics).toContainEqual({ name: "dispand.consult.wait", attributes: { "dispand.consult.outcome": "answered" } });
  // The consulted Job's session starts inside the span of the asking Job's consult.
  const [consultedId] = (await s.context.db.select({ id: runs.id }).from(runs).where(eq(runs.agentId, s.expert.id))).map((r) => r.id);
  const spans = telemetry.spans();
  const started = spans.find((x) => x.name === "engine.session.start" && x.attributes["dispand.run.id"] === consultedId)!;
  const parent = spans.find((x) => x.spanContext().spanId === started.parentSpanContext?.spanId);
  expect(parent?.attributes["dispand.job.id"]).toBe(runId);
  const exported = await telemetry.all();
  expect(exported).not.toContain("sentinel-consult-question-41");
  expect(exported).not.toContain("sentinel-consult-answer-42");
});

test("a consulted Job, which expects no outputs, is offered no submit_outputs and answers with its last message", async () => {
  const ids = { expert: "" };
  const s = await setup({
    asker: [() => ({ toolCalls: [{ id: "c1", name: "consult", args: { agent: ids.expert, question: "Which plan?" } }] }), () => ({ text: "Going with it." })],
    // A model that calls submit_outputs anyway, after its answer, is told no such tool exists.
    expert: [() => ({ text: "Plan B.", toolCalls: [{ id: "s1", name: "submit_outputs", args: {} }] }), () => ({ text: "Plan B, for its budget." })],
  });
  ids.expert = s.expert.id;
  const { runId } = await call(router.jobs.start, { triggerId: s.trigger.id }, { context: s.context });
  await s.until(runId, "succeeded");
  expect(s.seen.expert[0]!.tools.map((t) => t.name)).toEqual(["ask_user", "request_approval"]);
  expect(lastTool(s.seen.expert[1]!.items)).toMatchObject({ callId: "s1", isError: true });
  expect(lastTool(s.seen.asker[1]!.items)).toMatchObject({ isError: false, result: "Answer from the agent Expert:\n\nPlan B, for its budget." });
});

test("an agent the tool doesn't list is a bad call, and an agent that may consult none has no consult tool", async () => {
  const s = await setup({ asker: [() => ({ toolCalls: [{ id: "c1", name: "consult", args: { agent: "agent_other", question: "Hi?" } }] }), () => ({ text: "Fine." })], expert: [] });
  const { runId } = await call(router.jobs.start, { triggerId: s.trigger.id }, { context: s.context });
  await s.until(runId, "succeeded");
  expect(lastTool(s.seen.asker[1]!.items)).toMatchObject({ isError: true, result: expect.stringContaining("listed") });
  expect(await s.context.db.select().from(runs).where(eq(runs.agentId, s.expert.id))).toEqual([]);

  const none = await setup({ asker: [() => ({ text: "Done." })], expert: [] }, false);
  const job = await call(router.jobs.start, { triggerId: none.trigger.id }, { context: none.context });
  await none.until(job.runId, "succeeded");
  expect(none.seen.asker[0]!.tools.map((t) => t.name)).toEqual(["ask_user", "request_approval"]);
});

test("a workflow's agent step has no consult tool", async () => {
  const s = await setup({ asker: [() => ({ text: "A note." })], expert: [] });
  const workflow = await call(router.workflows.create, { name: "Ship" }, { context: s.context });
  await call(
    router.workflows.update,
    {
      id: workflow.id,
      name: "Ship",
      def: {
        trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } },
        steps: [{ id: "n_note", key: "note", type: "agent", name: "Note", agentId: s.asker.id, prompt: "Write a note." }],
        edges: [{ from: "n_go", to: "n_note" }],
      },
    },
    { context: s.context },
  );
  const { runId } = await call(router.runs.start, { workflowId: workflow.id }, { context: s.context });
  await s.until(runId, "succeeded");
  expect(s.seen.asker[0]!.tools.map((t) => t.name)).not.toContain("consult");
  const [step] = await s.context.db.select({ start: stepRuns.start }).from(stepRuns).where(eq(stepRuns.runId, runId));
  expect(step?.start?.consults).toBeUndefined();
});
