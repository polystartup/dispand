import { expect, test } from "vitest";
import type { ConditionOp } from "../workflows/condition.ts";
import type { WorkflowDef } from "../workflows/model.ts";
import { MAX_RESULTS } from "../workflows/loop.ts";
import { nextActions, toolValues, valuesFor, type StepState } from "./next-actions.ts";

/** Chat "Brief" → condition "If" on `brief.approved` → Then "T" / Else "E" → join "J". */
function ifElse(op: ConditionOp = "equals", operand = "yes"): WorkflowDef {
  return {
    trigger: { type: "manual", field: { id: "n_chat", key: "brief", type: "chat", label: "Brief", agentId: "a1", prompt: "Ask." } },
    steps: [
      { id: "n_if", key: "if", type: "condition", name: "If", value: { type: "output", nodeId: "n_chat", name: "approved" }, op, operand },
      { id: "n_t", key: "t", type: "agent", name: "T", agentId: "a1", prompt: "Ship {{brief.idea}}." },
      { id: "n_e", key: "e", type: "agent", name: "E", agentId: "a1", prompt: "Refuse." },
      { id: "n_j", key: "j", type: "agent", name: "J", agentId: "a1", prompt: "Report {{t.result}} or {{e.reason}}." },
    ],
    edges: [
      { from: "n_chat", to: "n_if" },
      { from: "n_if", to: "n_t", branch: "then" },
      { from: "n_if", to: "n_e", branch: "else" },
      { from: "n_t", to: "n_j" },
      { from: "n_e", to: "n_j" },
    ],
  };
}

type Status = StepState["status"];
/** Every node of `def` pending, but those given. */
function states(def: WorkflowDef, given: Record<string, Status | readonly [Status, Record<string, string>]>): StepState[] {
  const ids = [def.trigger.field.id, ...def.steps.map((s) => s.id)];
  return ids.map((nodeId) => {
    const g = given[nodeId] ?? "pending";
    const [status, outputs] = typeof g === "string" ? [g, g === "succeeded" ? {} : null] : g;
    return { nodeId, iteration: 0, status, outputs };
  });
}

test("a ready condition completes with matched", () => {
  const def = ifElse();
  expect(nextActions(def, states(def, { n_chat: ["succeeded", { approved: " Yes " }] }))).toEqual([
    { type: "complete", nodeId: "n_if", iteration: 0, outputs: { matched: "true" } },
  ]);
});

test("the untaken branch is skipped and its successors too", () => {
  const def = ifElse();
  def.steps.push({ id: "n_e2", key: "e2", type: "agent", name: "E2", agentId: "a1", prompt: "More." });
  def.edges.push({ from: "n_e", to: "n_e2" });
  const steps = states(def, { n_chat: "succeeded", n_if: ["succeeded", { matched: "true" }] });
  expect(nextActions(def, steps)).toEqual([
    { type: "start", nodeId: "n_t", iteration: 0 },
    { type: "skip", nodeId: "n_e", iteration: 0 },
  ]);
  const later = states(def, { n_chat: "succeeded", n_if: ["succeeded", { matched: "true" }], n_t: "running", n_e: "skipped" });
  expect(nextActions(def, later)).toEqual([{ type: "skip", nodeId: "n_e2", iteration: 0 }]);
});

test("join after if/else runs once", () => {
  const def = ifElse();
  const base = { n_chat: "succeeded", n_if: ["succeeded", { matched: "true" }], n_t: "succeeded", n_e: "skipped" } as const;
  expect(nextActions(def, states(def, base))).toEqual([{ type: "start", nodeId: "n_j", iteration: 0 }]);
  expect(nextActions(def, states(def, { ...base, n_j: "running" }))).toEqual([]);
});

test("a join waits for a branch still running", () => {
  const def = ifElse();
  def.edges.push({ from: "n_chat", to: "n_j" });
  const steps = states(def, { n_chat: "succeeded", n_if: "running" });
  expect(nextActions(def, steps)).toEqual([]);
});

test("a node fed only by dead edges is skipped", () => {
  const def = ifElse();
  const steps = states(def, { n_chat: "succeeded", n_if: ["succeeded", { matched: "false" }], n_t: "skipped", n_e: "skipped" });
  expect(nextActions(def, steps)).toEqual([{ type: "skip", nodeId: "n_j", iteration: 0 }]);
});

test("a condition error fails the step", () => {
  const def = ifElse("greater_than", "3");
  expect(nextActions(def, states(def, { n_chat: ["succeeded", { approved: "abc" }] }))).toEqual([
    { type: "fail", nodeId: "n_if", iteration: 0, error: "“abc” is not a number" },
  ]);
});

test("a ready button trigger completes and a step with no predecessor starts", () => {
  const def: WorkflowDef = {
    trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } },
    steps: [{ id: "n_a", key: "a", type: "agent", name: "A", agentId: "a1", prompt: "A." }],
    edges: [],
  };
  expect(nextActions(def, states(def, {}))).toEqual([
    { type: "complete", nodeId: "n_go", iteration: 0, outputs: {} },
    { type: "start", nodeId: "n_a", iteration: 0 },
  ]);
});

test("finish when every node is succeeded or skipped", () => {
  const def = ifElse();
  const done = { n_chat: "succeeded", n_if: ["succeeded", { matched: "true" }], n_t: "succeeded", n_e: "skipped", n_j: "succeeded" } as const;
  expect(nextActions(def, states(def, done))).toEqual([{ type: "finish", status: "succeeded" }]);
  expect(nextActions(def, states(def, { ...done, n_j: "running" }))).toEqual([]);
});

test("valuesFor gives a skipped node's referenced fields as empty text", () => {
  const def = ifElse();
  const steps = states(def, {
    n_chat: ["succeeded", { idea: "a CLI", approved: "yes" }],
    n_if: ["succeeded", { matched: "true" }],
    n_t: ["succeeded", { result: "shipped" }],
    n_e: "skipped",
  });
  expect(valuesFor(def, steps, "n_j")).toEqual({
    brief: { idea: "a CLI", approved: "yes" },
    if: { matched: "true" },
    t: { result: "shipped" },
    e: { reason: "" },
  });
});

test("valuesFor fills a skipped node named like an Object property", () => {
  const def = ifElse();
  def.steps[2] = { ...def.steps[2]!, key: "constructor" } as WorkflowDef["steps"][number];
  def.steps[3] = { ...def.steps[3]!, prompt: "Report {{constructor.name}}." } as WorkflowDef["steps"][number];
  const steps = states(def, { n_chat: "succeeded", n_if: ["succeeded", { matched: "true" }], n_t: "succeeded", n_e: "skipped" });
  expect(valuesFor(def, steps, "n_j").constructor).toEqual({ name: "" });
});

test("a schedule trigger completes with scheduled_for in its timezone, without a session", () => {
  const def: WorkflowDef = {
    trigger: { type: "schedule", field: { id: "n_s", key: "schedule", type: "schedule", label: "Schedule", cron: "0 9 * * *", timezone: "Europe/Paris" } },
    steps: [{ id: "n_a", key: "a", type: "agent", name: "A", agentId: "a1", prompt: "Go." }],
    edges: [{ from: "n_s", to: "n_a" }],
  };
  expect(nextActions(def, states(def, {}), { scheduledFor: new Date("2026-11-05T08:00:00Z") })).toEqual([
    { type: "complete", nodeId: "n_s", iteration: 0, outputs: { scheduled_for: "2026-11-05T09:00:00+01:00" } },
  ]);
});

test("a ready data step runs in the engine, never starting a session", () => {
  const def: WorkflowDef = {
    trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } },
    steps: [{ id: "n_d", key: "d", type: "data", name: "D", action: "create-row", tableId: "t1", inputs: [] }],
    edges: [{ from: "n_go", to: "n_d" }],
  };
  expect(nextActions(def, states(def, { n_go: "succeeded" }))).toEqual([
    { type: "data", nodeId: "n_d", iteration: 0 },
  ]);
});

/** Button → loop "each" over `list.items` from a chat → body: A → B; after it "R". */
function forEach(items: string, maxIterations = 20): { def: WorkflowDef; base: StepState[] } {
  const def: WorkflowDef = {
    trigger: { type: "manual", field: { id: "n_chat", key: "list", type: "chat", label: "List", agentId: "a1", prompt: "Ask." } },
    steps: [
      { id: "n_each", key: "each", type: "loop", name: "Each", list: { type: "output", nodeId: "n_chat", name: "items" }, maxIterations },
      { id: "n_a", key: "a", type: "agent", name: "A", agentId: "a1", prompt: "Do {{each.item}} ({{each.index}}) for {{list.who}}.", loopId: "n_each" },
      { id: "n_b", key: "b", type: "agent", name: "B", agentId: "a1", prompt: "Check {{a.done}}.", loopId: "n_each" },
      { id: "n_r", key: "r", type: "agent", name: "R", agentId: "a1", prompt: "Report {{each.results}}." },
    ],
    edges: [
      { from: "n_chat", to: "n_each" },
      { from: "n_a", to: "n_b" },
      { from: "n_each", to: "n_r" },
    ],
  };
  const base: StepState[] = [
    { nodeId: "n_chat", iteration: 0, status: "succeeded", outputs: { items, who: "me" } },
    { nodeId: "n_each", iteration: 0, status: "pending", outputs: null },
    { nodeId: "n_r", iteration: 0, status: "pending", outputs: null },
  ];
  return { def, base };
}

const row = (nodeId: string, iteration: number, status: Status, outputs: Record<string, string> | null = null): StepState => ({ nodeId, iteration, status, outputs });
const running = (steps: StepState[]) => steps.map((s) => (s.nodeId === "n_each" ? { ...s, status: "running" as const } : s));

test("a ready loop opens its first iteration", () => {
  const { def, base } = forEach('["x","y"]');
  expect(nextActions(def, base)).toEqual([
    { type: "start", nodeId: "n_each", iteration: 0 },
    { type: "open-iteration", loopId: "n_each", iteration: 1 },
  ]);
  // Started, but the iteration's rows aren't there yet (a restart in between): it opens again.
  expect(nextActions(def, running(base))).toEqual([{ type: "open-iteration", loopId: "n_each", iteration: 1 }]);
  // Opened: the body's entry step starts in iteration 1.
  expect(nextActions(def, [...running(base), row("n_a", 1, "pending"), row("n_b", 1, "pending")])).toEqual([{ type: "start", nodeId: "n_a", iteration: 1 }]);
});

test("the next iteration opens once the previous one is done", () => {
  const { def, base } = forEach('["x","y"]');
  const first = [...running(base), row("n_a", 1, "succeeded", { done: "ok" }), row("n_b", 1, "running")];
  expect(nextActions(def, first)).toEqual([]);
  const done = [...running(base), row("n_a", 1, "succeeded", { done: "ok" }), row("n_b", 1, "succeeded", { result: "fine" })];
  expect(nextActions(def, done)).toEqual([{ type: "open-iteration", loopId: "n_each", iteration: 2 }]);
  const second = [...done, row("n_a", 2, "succeeded", { done: "ok2" }), row("n_b", 2, "pending")];
  expect(nextActions(def, second)).toEqual([{ type: "start", nodeId: "n_b", iteration: 2 }]);
});

test("the last iteration completes the loop with count and results", () => {
  const { def, base } = forEach('["x","y"]');
  const steps = [
    ...running(base),
    row("n_a", 1, "succeeded", { done: "1" }),
    row("n_b", 1, "succeeded", { result: "r1" }),
    row("n_a", 2, "succeeded", { done: "2" }),
    row("n_b", 2, "skipped"),
  ];
  expect(nextActions(def, steps)).toEqual([
    { type: "complete", nodeId: "n_each", iteration: 0, outputs: { count: "2", results: '[{"a":{"done":"1"},"b":{"result":"r1"}},{"a":{"done":"2"}}]' } },
  ]);
  // The run finishes on its top-level nodes: body rows don't hold it.
  const after = steps.map((s) => (s.nodeId === "n_each" ? { ...s, status: "succeeded" as const } : s.nodeId === "n_r" ? { ...s, status: "succeeded" as const } : s));
  expect(nextActions(def, after)).toEqual([{ type: "finish", status: "succeeded" }]);
});

test("results over the cap fail the loop instead of completing it", () => {
  const { def, base } = forEach('["x"]');
  const steps = [...running(base), row("n_a", 1, "succeeded", { done: "a".repeat(MAX_RESULTS) }), row("n_b", 1, "skipped")];
  expect(nextActions(def, steps)).toEqual([{ type: "fail", nodeId: "n_each", iteration: 0, error: "The loop's results are over 1,000,000 characters" }]);
});

test("a loop's list that is empty, not a list or over the cap", () => {
  const empty = forEach("[]");
  expect(nextActions(empty.def, empty.base)).toEqual([{ type: "complete", nodeId: "n_each", iteration: 0, outputs: { count: "0", results: "[]" } }]);
  const text = forEach("x, y");
  expect(nextActions(text.def, text.base)).toEqual([{ type: "fail", nodeId: "n_each", iteration: 0, error: "“items” is not a list (a JSON array)" }]);
  const long = forEach("[1,2,3]", 2);
  expect(nextActions(long.def, long.base)).toEqual([{ type: "fail", nodeId: "n_each", iteration: 0, error: "The list has 3 items; this loop runs at most 2" }]);
});

test("valuesFor inside an iteration gives the item and that iteration's body outputs only", () => {
  const { def, base } = forEach('[{"name":"x"},"y"]');
  const steps = [
    ...running(base),
    row("n_a", 1, "succeeded", { done: "first" }),
    row("n_b", 1, "succeeded", {}),
    row("n_a", 2, "succeeded", { done: "second" }),
    row("n_b", 2, "pending"),
  ];
  expect(valuesFor(def, steps, "n_a", 1)).toMatchObject({ each: { item: '{"name":"x"}', index: "1", name: "x" }, list: { who: "me" } });
  expect(valuesFor(def, steps, "n_b", 2)).toMatchObject({ each: { item: "y", index: "2" }, a: { done: "second" } });
});

test("a condition in a loop body on a field the item lacks compares empty text, not Object's", () => {
  const { def, base } = forEach("[{}]");
  def.steps[1] = { id: "n_a", key: "a", type: "condition", name: "A", value: { type: "output", nodeId: "n_each", name: "toString" }, op: "is_empty", operand: "", loopId: "n_each" };
  def.edges[1] = { from: "n_a", to: "n_b", branch: "then" };
  expect(nextActions(def, [...running(base), row("n_a", 1, "pending"), row("n_b", 1, "pending")])).toEqual([
    { type: "complete", nodeId: "n_a", iteration: 1, outputs: { matched: "true" } },
  ]);
});

/** ifElse, then a Tool step after the join reading the chat, a literal, the skipped "E" and a field the chat never gave. */
function withTool(): WorkflowDef {
  const def = ifElse();
  def.steps.push({
    id: "n_tool",
    key: "repo",
    type: "tool",
    name: "Repo",
    toolId: "tool_gh",
    action: "create_repository",
    inputs: [
      { param: "name", source: { type: "output", nodeId: "n_chat", name: "idea" } },
      { param: "owner", source: { type: "value", value: "acme" } },
      { param: "topic", source: { type: "output", nodeId: "n_e", name: "reason" } },
      { param: "missing", source: { type: "output", nodeId: "n_chat", name: "nope" } },
    ],
  });
  def.edges.push({ from: "n_j", to: "n_tool" });
  return def;
}

test("a ready tool step runs in the engine", () => {
  const def = withTool();
  const steps = states(def, { n_chat: "succeeded", n_if: ["succeeded", { matched: "true" }], n_t: "succeeded", n_e: "skipped", n_j: "succeeded" });
  expect(nextActions(def, steps)).toEqual([{ type: "tool", nodeId: "n_tool", iteration: 0 }]);
});

test("toolValues: literals as is, upstream values, a skipped step's name, \"\" for a missing field", () => {
  const def = withTool();
  const steps = states(def, { n_chat: ["succeeded", { idea: "chat" }], n_if: ["succeeded", { matched: "true" }], n_t: "succeeded", n_e: "skipped", n_j: "succeeded" });
  expect([...toolValues(def, steps, "n_tool")]).toEqual([
    ["name", "chat"],
    ["owner", "acme"],
    ["topic", { skipped: "E" }],
    ["missing", ""],
  ]);
});
