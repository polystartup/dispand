import type { StepStatus } from "../db/schema.ts";
import type { ArgValue } from "../tools/arguments.ts";
import { evaluateCondition } from "../workflows/condition.ts";
import { itemValues, loopResults, MAX_RESULTS, parseList } from "../workflows/loop.ts";
import { loopOf, nodesOf, type Edge, type LoopStep, type Ref, type ToolStep, type WorkflowDef, type WorkflowNode } from "../workflows/model.ts";
import { isoInZone } from "../workflows/schedule.ts";
import { references } from "../workflows/template.ts";

// Pure: what a run does next, from its definition and its steps as they are. `Engine` only applies it.

/** One node of a run as `nextActions` sees it (iteration 0 outside loops, from 1 inside). */
export type StepState = { nodeId: string; iteration: number; status: StepStatus; outputs: Record<string, string> | null };

export type Action =
  | { type: "start"; nodeId: string; iteration: number }
  | { type: "data"; nodeId: string; iteration: number }
  | { type: "tool"; nodeId: string; iteration: number }
  | { type: "complete"; nodeId: string; iteration: number; outputs: Record<string, string> }
  | { type: "skip"; nodeId: string; iteration: number }
  | { type: "fail"; nodeId: string; iteration: number; error: string }
  | { type: "open-iteration"; loopId: string; iteration: number }
  | { type: "finish"; status: "succeeded" };

const DONE: StepStatus[] = ["succeeded", "skipped"];

/**
 * An edge is live when its source succeeded and the edge is on the branch the source took (or on
 * none); dead when its source was skipped or took the other branch; waiting otherwise.
 */
function edgeState(edge: Edge, source: StepState | undefined): "live" | "dead" | "waiting" {
  if (source?.status === "skipped") return "dead";
  if (source?.status !== "succeeded") return "waiting";
  if (edge.branch === undefined) return "live";
  return source.outputs?.matched === (edge.branch === "then" ? "true" : "false") ? "live" : "dead";
}

/** The rows `nodeId` sees by node id in `iteration`: top-level ones, and its own loop's in that iteration, the loop giving the item's values. */
function visible(def: WorkflowDef, steps: StepState[], nodeId: string, iteration: number): Map<string, StepState> {
  const seen = new Map(steps.filter((s) => s.iteration === 0).map((s) => [s.nodeId, s]));
  const loopId = loopOf(def, nodeId);
  const loop = def.steps.find((s): s is LoopStep => s.id === loopId && s.type === "loop");
  if (!loop) return seen;
  for (const s of steps) if (s.iteration === iteration && loopOf(def, s.nodeId) === loop.id) seen.set(s.nodeId, s);
  const list = itemsOf(loop, seen);
  const item = "items" in list ? list.items[iteration - 1] : undefined;
  seen.set(loop.id, { nodeId: loop.id, iteration, status: "succeeded", outputs: itemValues(item, iteration - 1) });
  return seen;
}

/** The value `ref` names, `""` when missing (own fields only: never `toString` from Object's). */
function valueOf(ref: Ref | null, seen: Map<string, StepState>): string {
  const outputs = ref ? seen.get(ref.nodeId)?.outputs : null;
  return outputs && Object.hasOwn(outputs, ref!.name) ? outputs[ref!.name]! : "";
}

/** A loop's items, from its list's value (upstream outputs never change, so each read gives the same). */
function itemsOf(loop: LoopStep, seen: Map<string, StepState>): { items: unknown[] } | { error: string } {
  const list = parseList(valueOf(loop.list, seen));
  return "error" in list ? { error: `“${loop.list?.name ?? "list"}” ${list.error}` } : list;
}

/**
 * What to do now: a pending node whose incoming edges are all decided runs when one of them is
 * live (so a join runs once, after all its branches) and is skipped when none is. A ready button,
 * schedule trigger (with `scheduled_for`, from `trigger`) or condition completes here; a data or
 * Tool step runs in the engine; a loop checks its list and opens its first iteration; any other ready node
 * starts a session. Inside a loop's iteration its body follows the same rules; once it is done,
 * the next iteration opens, or the loop completes after the last. Every top-level node succeeded
 * or skipped finishes the run.
 */
export function nextActions(def: WorkflowDef, steps: StepState[], trigger?: { scheduledFor: Date }): Action[] {
  const top = new Map(steps.filter((s) => s.iteration === 0).map((s) => [s.nodeId, s]));
  const nodes = nodesOf(def);
  const topNodes = nodes.filter((n) => n.loopId === undefined);
  if (topNodes.every((n) => DONE.includes(top.get(n.id)?.status ?? "pending"))) return [{ type: "finish", status: "succeeded" }];
  const actions: Action[] = [];
  for (const node of topNodes) {
    const step = def.steps.find((s) => s.id === node.id);
    if (step?.type === "loop" && top.get(node.id)?.status === "running") actions.push(...iterate(def, steps, step, nodes, trigger));
  }
  return [...actions, ...scopeActions(def, topNodes, 0, top, trigger)];
}

/** A running loop: its current iteration's actions, or opening the next, or completing it. */
function iterate(def: WorkflowDef, steps: StepState[], loop: LoopStep, nodes: WorkflowNode[], trigger?: { scheduledFor: Date }): Action[] {
  const body = nodes.filter((n) => n.loopId === loop.id);
  const ids = new Set(body.map((n) => n.id));
  const rows = steps.filter((s) => ids.has(s.nodeId));
  const current = Math.max(0, ...rows.map((s) => s.iteration));
  const list = itemsOf(loop, new Map(steps.filter((s) => s.iteration === 0).map((s) => [s.nodeId, s])));
  if ("error" in list) return [{ type: "fail", nodeId: loop.id, iteration: 0, error: list.error }];
  if (current === 0) return [{ type: "open-iteration", loopId: loop.id, iteration: 1 }];
  const seen = visible(def, steps, body[0]!.id, current);
  if (!body.every((n) => DONE.includes(seen.get(n.id)?.status ?? "pending"))) return scopeActions(def, body, current, seen, trigger);
  if (current < list.items.length) return [{ type: "open-iteration", loopId: loop.id, iteration: current + 1 }];
  const results = Array.from({ length: current }, (_, i) =>
    Object.fromEntries(body.flatMap((n) => {
      const row = rows.find((s) => s.nodeId === n.id && s.iteration === i + 1);
      return row?.status === "succeeded" ? [[n.key, row.outputs ?? {}]] : [];
    })),
  );
  const text = loopResults(results);
  if (text.length > MAX_RESULTS) return [{ type: "fail", nodeId: loop.id, iteration: 0, error: `The loop's results are over ${MAX_RESULTS.toLocaleString("en")} characters` }];
  return [{ type: "complete", nodeId: loop.id, iteration: 0, outputs: { count: String(current), results: text } }];
}

/** The ready nodes of one scope (top level, or a loop's body in `iteration`), `seen` being the rows they see. */
function scopeActions(def: WorkflowDef, nodes: WorkflowNode[], iteration: number, seen: Map<string, StepState>, trigger?: { scheduledFor: Date }): Action[] {
  const actions: Action[] = [];
  for (const node of nodes) {
    if (seen.get(node.id)?.status !== "pending") continue;
    const incoming = def.edges.filter((e) => e.to === node.id).map((e) => edgeState(e, seen.get(e.from)));
    if (incoming.includes("waiting")) continue;
    const at = { nodeId: node.id, iteration };
    if (incoming.length > 0 && !incoming.includes("live")) {
      actions.push({ type: "skip", ...at });
      continue;
    }
    const step = def.steps.find((s) => s.id === node.id);
    if (node.type === "button") actions.push({ type: "complete", ...at, outputs: {} });
    else if (def.trigger.type === "schedule" && node.id === def.trigger.field.id) {
      // The time the run was fired for (or started, for a manual start), in the schedule's timezone.
      const outputs: Record<string, string> = trigger ? { scheduled_for: isoInZone(trigger.scheduledFor, def.trigger.field.timezone) } : {};
      actions.push({ type: "complete", ...at, outputs });
    }
    else if (step?.type === "condition") {
      const result = evaluateCondition(step.op, valueOf(step.value, seen), step.operand);
      actions.push("error" in result ? { type: "fail", ...at, error: result.error } : { type: "complete", ...at, outputs: { matched: String(result.matched) } });
    } else if (step?.type === "loop") {
      const list = itemsOf(step, seen);
      if ("error" in list) actions.push({ type: "fail", ...at, error: list.error });
      else if (list.items.length > step.maxIterations) {
        actions.push({ type: "fail", ...at, error: `The list has ${list.items.length} items; this loop runs at most ${step.maxIterations}` });
      } else if (list.items.length === 0) actions.push({ type: "complete", ...at, outputs: { count: "0", results: loopResults([]) } });
      else actions.push({ type: "start", ...at }, { type: "open-iteration", loopId: step.id, iteration: 1 });
    } else if (step?.type === "data") actions.push({ type: "data", ...at });
    else if (step?.type === "tool") actions.push({ type: "tool", ...at });
    else actions.push({ type: "start", ...at });
  }
  return actions;
}

/**
 * The values `nodeId`'s prompt is filled in with in `iteration`, by node key: every succeeded
 * node's outputs it sees (its loop's item, and its loop body's in that iteration only), and `""`
 * for each field it references on a skipped node (a join after an untaken branch).
 */
export function valuesFor(def: WorkflowDef, steps: StepState[], nodeId: string, iteration = 0): Record<string, Record<string, string>> {
  const seen = visible(def, steps, nodeId, iteration);
  const nodes = nodesOf(def);
  const values = Object.create(null) as Record<string, Record<string, string>>;
  for (const n of nodes) {
    const s = seen.get(n.id);
    if (s?.status === "succeeded" && s.outputs) values[n.key] = { ...s.outputs };
  }
  const reader = nodes.find((n) => n.id === nodeId);
  for (const ref of references(reader?.prompt ?? "")) {
    const source = nodes.find((n) => n.key === ref.key);
    if (source && seen.get(source.id)?.status === "skipped") {
      // Own properties only: a key like `constructor` must not reach Object's.
      if (!Object.hasOwn(values, ref.key)) values[ref.key] = Object.create(null) as Record<string, string>;
      values[ref.key]![ref.field] = "";
    }
  }
  return values;
}

/** Each succeeded node's outputs `nodeId` sees in `iteration`, by node id: what a data step's sources read. */
export function outputsFor(def: WorkflowDef, steps: StepState[], nodeId: string, iteration = 0): Record<string, Record<string, string>> {
  const seen = visible(def, steps, nodeId, iteration);
  return Object.fromEntries([...seen].flatMap(([id, s]) => (s.status === "succeeded" && s.outputs ? [[id, s.outputs]] : [])));
}

/**
 * The values a Tool step's wired parameters get in `iteration`: a literal as is, an upstream value
 * from what the step sees (`""` when its node didn't give that field), or, when that node was
 * skipped, its name. Unwired parameters have no entry.
 */
export function toolValues(def: WorkflowDef, steps: StepState[], nodeId: string, iteration = 0): Map<string, ArgValue> {
  const step = def.steps.find((s): s is ToolStep => s.id === nodeId && s.type === "tool");
  const seen = visible(def, steps, nodeId, iteration);
  const nodes = nodesOf(def);
  const values = new Map<string, ArgValue>();
  for (const { param, source } of step?.inputs ?? []) {
    if (source.type === "value") values.set(param, source.value);
    else if (seen.get(source.nodeId)?.status === "skipped") values.set(param, { skipped: nodes.find((n) => n.id === source.nodeId)?.name ?? source.nodeId });
    else values.set(param, valueOf(source, seen));
  }
  return values;
}
