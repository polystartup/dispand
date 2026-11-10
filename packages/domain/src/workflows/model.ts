import { OutputField } from "@dispand/runner-protocol";
import { z } from "zod";
import { FILTER_OP_NAMES } from "../data/query.ts";
import { StorableText } from "../text.ts";
import { CONDITION_OPS } from "./condition.ts";
import { DEFAULT_ITERATIONS, MAX_ITERATIONS } from "./loop.ts";
import { references, renameReferences } from "./template.ts";

export { StorableText };

// Pure: imported by the web editor too (`@dispand/domain/workflows/model`).

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** A node's name as a variable: `{{key.field}}`. */
const Key = z.string().regex(/^[a-z0-9_]{1,64}$/);
const Name = StorableText(100);
const Prompt = StorableText(100_000);
/** "" until the owner picks one. */
const AgentId = z.string().max(64);
/** The loop whose body a step is in (no loopId: outside every loop). */
const LoopId = Id.optional();

export const TriggerField = z.discriminatedUnion("type", [
  z.object({ id: Id, key: Key, type: z.literal("button"), label: Name }),
  z.object({ id: Id, key: Key, type: z.literal("chat"), label: Name, agentId: AgentId, prompt: Prompt }),
]);
export type TriggerField = z.infer<typeof TriggerField>;

export const AgentStep = z.object({ id: Id, key: Key, type: z.literal("agent"), name: Name, agentId: AgentId, prompt: Prompt, loopId: LoopId });
export type AgentStep = z.infer<typeof AgentStep>;

/** A value an upstream node gives, named by the node's id so renaming the node keeps it. */
export const Ref = z.object({ type: z.literal("output"), nodeId: Id, name: OutputField.shape.name });
export type Ref = z.infer<typeof Ref>;

/** If/else: its edges out carry `branch`; it gives `matched` ("true" or "false"). */
export const ConditionStep = z.object({
  id: Id,
  key: Key,
  type: z.literal("condition"),
  name: Name,
  value: Ref.nullable(),
  op: z.enum(CONDITION_OPS),
  operand: StorableText(1000),
  loopId: LoopId,
});
export type ConditionStep = z.infer<typeof ConditionStep>;

/** What a data step's input or filter takes: a literal, or a value an upstream node gives. */
export const Source = z.discriminatedUnion("type", [z.object({ type: z.literal("value"), value: StorableText(10_000) }), Ref]);
export type Source = z.infer<typeof Source>;

export const DataInput = z.object({ fieldId: Id, source: Source });
export type DataInput = z.infer<typeof DataInput>;

export const DataFilter = z.object({ fieldId: Id, op: z.enum(FILTER_OP_NAMES), value: Source.optional() });
export type DataFilter = z.infer<typeof DataFilter>;

/** "" until the owner picks one. */
const TableId = z.string().max(64);
const dataBase = { id: Id, key: Key, type: z.literal("data"), name: Name, tableId: TableId, loopId: LoopId };

/** Creates, updates or finds rows of a table, inside the server; its fields' values come from `Source`s. */
export const DataStep = z.discriminatedUnion("action", [
  z.object({ ...dataBase, action: z.literal("create-row"), inputs: z.array(DataInput).max(200) }),
  z.object({ ...dataBase, action: z.literal("update-row"), rowId: Source, inputs: z.array(DataInput).max(200) }),
  z.object({ ...dataBase, action: z.literal("find-rows"), filters: z.array(DataFilter).max(20), limit: z.number().int().min(1).max(100).default(20) }),
]);
export type DataStep = z.infer<typeof DataStep>;

/**
 * For each item of a list from upstream, runs its body (the steps whose `loopId` is its id) once,
 * one iteration after another. It gives `count` and `results` after it, `item`, `index` and an
 * object item's fields inside its body.
 */
export const LoopStep = z.object({
  id: Id,
  key: Key,
  type: z.literal("loop"),
  name: Name,
  list: Ref.nullable(),
  maxIterations: z.number().int().min(1).max(MAX_ITERATIONS),
  loopId: LoopId,
});
export type LoopStep = z.infer<typeof LoopStep>;

/** One parameter of a tool's action and where its value comes from. */
export const ToolInput = z.object({ param: StorableText(200).min(1), source: Source });
export type ToolInput = z.infer<typeof ToolInput>;

/**
 * Calls one action of an installed tool, inside the server (never on a runner, never given to an
 * agent). Each wired parameter is coerced to the type the action's input schema gives it.
 */
export const ToolStep = z.object({
  id: Id,
  key: Key,
  type: z.literal("tool"),
  name: Name,
  /** "" until the owner picks one. */
  toolId: StorableText(64),
  /** "" until the owner picks one. */
  action: StorableText(200),
  inputs: z.array(ToolInput).max(100),
  loopId: LoopId,
});
export type ToolStep = z.infer<typeof ToolStep>;

export const Step = z.discriminatedUnion("type", [AgentStep, ConditionStep, DataStep, LoopStep, ToolStep]);
export type Step = z.infer<typeof Step>;

export const Edge = z.object({ from: Id, to: Id, branch: z.enum(["then", "else"]).optional() });
export type Edge = z.infer<typeof Edge>;

/** A cron schedule (5 fields) read in an IANA timezone; it gives `scheduled_for`. */
export const ScheduleField = z.object({
  id: Id,
  key: Key,
  type: z.literal("schedule"),
  label: Name,
  cron: StorableText(100),
  timezone: z.string().max(64),
});
export type ScheduleField = z.infer<typeof ScheduleField>;

export const Trigger = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual"), field: TriggerField }),
  z.object({ type: z.literal("schedule"), field: ScheduleField }),
]);
export type Trigger = z.infer<typeof Trigger>;

export const WorkflowDef = z.object({
  trigger: Trigger,
  steps: z.array(Step).max(50),
  edges: z.array(Edge).max(200),
});
export type WorkflowDef = z.infer<typeof WorkflowDef>;

/** The trigger or a step: what the canvas draws and what prompts reference by key. */
export type WorkflowNode = {
  id: string;
  key: string;
  name: string;
  agentId?: string;
  prompt?: string;
  kind: "trigger" | "step";
  /** The trigger field's type or the step's. */
  type: Trigger["field"]["type"] | Step["type"];
  /** The loop whose body the step is in. */
  loopId?: string;
};

/** Whether an agent drives the node (a chat or an agent step): it gives what later steps ask of it. */
export function agentDriven(node: WorkflowNode): boolean {
  return node.type === "chat" || node.type === "agent";
}

/** A data step's sources, each with the input or filter it fills. */
export function dataSources(step: DataStep): { target: { fieldId: string } | "rowId" | { filter: number }; fieldId?: string; source: Source }[] {
  switch (step.action) {
    case "create-row":
      return step.inputs.map((i) => ({ target: { fieldId: i.fieldId }, fieldId: i.fieldId, source: i.source }));
    case "update-row":
      return [
        { target: "rowId" as const, source: step.rowId },
        ...step.inputs.map((i) => ({ target: { fieldId: i.fieldId }, fieldId: i.fieldId, source: i.source })),
      ];
    case "find-rows":
      return step.filters.flatMap((f, i) => (f.value ? [{ target: { filter: i }, fieldId: f.fieldId, source: f.value }] : []));
  }
}

/** Every value a node reads from upstream, by node id: its prompt's `{{key.field}}`, a condition's value, a data or tool step's wired sources. */
export function readsOf(def: WorkflowDef, nodeId: string): Ref[] {
  const nodes = nodesOf(def);
  const byKey = new Map(nodes.map((n) => [n.key, n.id]));
  const prompt = references(nodes.find((n) => n.id === nodeId)?.prompt ?? "").flatMap((r) => {
    const id = byKey.get(r.key);
    return id === undefined ? [] : [{ type: "output" as const, nodeId: id, name: r.field }];
  });
  const step = def.steps.find((s) => s.id === nodeId);
  if (step?.type === "condition") return step.value ? [...prompt, step.value] : prompt;
  if (step?.type === "loop") return step.list ? [step.list] : [];
  if (step?.type === "data") return dataSources(step).flatMap((s) => (s.source.type === "output" ? [s.source] : []));
  if (step?.type === "tool") return step.inputs.flatMap((i) => (i.source.type === "output" ? [i.source] : []));
  return prompt;
}

export function nodesOf(def: WorkflowDef): WorkflowNode[] {
  const f = def.trigger.field;
  return [
    { id: f.id, key: f.key, name: f.label, kind: "trigger", type: f.type, ...(f.type === "chat" ? { agentId: f.agentId, prompt: f.prompt } : {}) },
    ...def.steps.map((s) => ({
      id: s.id,
      key: s.key,
      name: s.name,
      kind: "step" as const,
      type: s.type,
      ...(s.type === "agent" ? { agentId: s.agentId, prompt: s.prompt } : {}),
      ...(s.loopId ? { loopId: s.loopId } : {}),
    })),
  ];
}

function isCondition(def: WorkflowDef, nodeId: string): boolean {
  return def.steps.some((s) => s.id === nodeId && s.type === "condition");
}

/** Why `branch` can't go on an edge out of `from`, or null when it fits. */
export function branchProblem(def: WorkflowDef, from: string, branch: Edge["branch"]): string | null {
  if (isCondition(def, from)) return branch === undefined ? "Choose Then or Else for this link" : null;
  return branch === undefined ? null : "Only a condition has Then and Else";
}

/** A key for `name`: lowercase letters, digits and `_`. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 56);
  return slug || "step";
}

/** `slugify(name)`, with `_2`, `_3`… when another node already has it. */
export function uniqueKey(def: WorkflowDef, name: string, exceptId?: string): string {
  const taken = new Set(nodesOf(def).filter((n) => n.id !== exceptId).map((n) => n.key));
  const base = slugify(name);
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}_${i}`;
  return key;
}

/** Renames a node; its key follows the name and every prompt's references follow the key. */
export function renameNode(def: WorkflowDef, nodeId: string, name: string): WorkflowDef {
  const node = nodesOf(def).find((n) => n.id === nodeId);
  if (!node) return def;
  const key = uniqueKey(def, name, nodeId);
  const rewrite = (prompt: string) => renameReferences(prompt, node.key, key);
  const t = def.trigger;
  const trigger: Trigger =
    t.type === "schedule"
      ? { type: "schedule", field: t.field.id === nodeId ? { ...t.field, label: name, key } : t.field }
      : { type: "manual", field: t.field.id === nodeId ? { ...t.field, label: name, key } : t.field };
  return {
    ...def,
    trigger: trigger.field.type === "chat" ? { type: "manual", field: { ...trigger.field, prompt: rewrite(trigger.field.prompt) } } : trigger,
    steps: def.steps.map((s) => {
      const renamed = s.id === nodeId ? { ...s, name, key } : s;
      return renamed.type === "agent" ? { ...renamed, prompt: rewrite(renamed.prompt) } : renamed;
    }),
  };
}

export type StepType = WorkflowDef["steps"][number]["type"];

/**
 * Where a new step goes: after a node (a node that already has successors gets a parallel
 * branch; after a condition, on its Then or Else branch), on an edge (between its ends), or as
 * a new entry step of a loop's body. A step goes in the loop its neighbour is in. A condition
 * added on an edge continues to the edge's end on its Then branch.
 */
export type AddAt = { after: string; branch?: "then" | "else" } | { edge: { from: string; to: string } } | { loop: string };

/** The loop whose body `nodeId` is in, if any. */
export function loopOf(def: WorkflowDef, nodeId: string): string | undefined {
  return def.steps.find((s) => s.id === nodeId)?.loopId;
}

/** Adds a new step of `type` at `at`. */
export function addStep(def: WorkflowDef, at: AddAt, id: string, type: StepType): WorkflowDef {
  if ("loop" in at && !def.steps.some((s) => s.id === at.loop && s.type === "loop")) throw new Error("This step's loop doesn't exist");
  const loopId = "loop" in at ? at.loop : loopOf(def, "after" in at ? at.after : at.edge.from);
  if (type === "loop" && loopId) throw new Error("Loops can't be nested yet");
  if ("after" in at) {
    const problem = branchProblem(def, at.after, at.branch);
    if (problem) throw new Error(problem);
  }
  const names = new Set(nodesOf(def).map((n) => n.name));
  // Conditions are "If", "If 2"…, loops "For each", "For each 2"…: the canvas names a card's "+" after it.
  const numbered = type === "condition" ? "If" : type === "loop" ? "For each" : null;
  let name = numbered ?? `${type === "data" ? "Data" : type === "tool" ? "Tool" : "Step"} ${def.steps.length + 1}`;
  for (let i = 2; numbered && names.has(name); i++) name = `${numbered} ${i}`;
  const key = uniqueKey(def, name);
  const base = { id, key, name, ...(loopId ? { loopId } : {}) };
  const step: Step =
    type === "condition"
      ? { ...base, type, value: null, op: "equals", operand: "" }
      : type === "data"
        ? { ...base, type, action: "create-row", tableId: "", inputs: [] }
        : type === "loop"
          ? { ...base, type, list: null, maxIterations: DEFAULT_ITERATIONS }
          : type === "tool"
            ? { ...base, type, toolId: "", action: "", inputs: [] }
            : { ...base, type, agentId: "", prompt: "" };
  if ("loop" in at) return { ...def, steps: [...def.steps, step] };
  const replaced = "edge" in at ? def.edges.find((e) => e.from === at.edge.from && e.to === at.edge.to) : undefined;
  const edges: Edge[] =
    "edge" in at
      ? [
          ...def.edges.filter((e) => e !== replaced),
          { from: at.edge.from, to: id, ...(replaced?.branch ? { branch: replaced.branch } : {}) },
          // A condition inserted on a link leads on through Then: its links out all need a branch.
          { from: id, to: at.edge.to, ...(type === "condition" ? { branch: "then" as const } : {}) },
        ]
      : [...def.edges, { from: at.after, to: id, ...(at.branch ? { branch: at.branch } : {}) }];
  return { ...def, steps: [...def.steps, step], edges };
}

/** Links `from` to `to`, unless the link can't be made: then why, for the owner. */
export function connect(
  def: WorkflowDef,
  from: string,
  to: string,
  branch?: "then" | "else",
): { def: WorkflowDef } | { refused: string } {
  if (from === to) return { refused: "A step can't follow itself" };
  if (def.edges.some((e) => e.from === from && e.to === to)) return { refused: "These steps are already linked" };
  if (to === def.trigger.field.id) return { refused: "Nothing runs before the trigger" };
  if (loopOf(def, from) !== loopOf(def, to)) return { refused: "A link can't cross the edge of a loop" };
  if (upstreamOf(def, from).has(to)) return { refused: "This link would make a loop" };
  const problem = branchProblem(def, from, branch);
  if (problem) return { refused: problem };
  return { def: { ...def, edges: [...def.edges, { from, to, ...(branch ? { branch } : {}) }] } };
}

/** Removes the link `from` → `to`; both nodes stay. */
export function disconnect(def: WorkflowDef, edge: { from: string; to: string }): WorkflowDef {
  return { ...def, edges: def.edges.filter((e) => e.from !== edge.from || e.to !== edge.to) };
}

/**
 * The nodes `nodeId` waits for, directly or not (cycles are walked once): a body step also waits
 * for its loop, so for what its loop waits for.
 */
export function upstreamOf(def: WorkflowDef, nodeId: string): Set<string> {
  const seen = new Set<string>();
  const todo = [nodeId];
  while (todo.length > 0) {
    const id = todo.pop()!;
    const loopId = loopOf(def, id);
    if (loopId !== undefined && !seen.has(loopId)) {
      seen.add(loopId);
      todo.push(loopId);
    }
    for (const e of def.edges) {
      if (e.to === id && !seen.has(e.from)) {
        seen.add(e.from);
        todo.push(e.from);
      }
    }
  }
  return seen;
}

/** Removes a step (a loop with its body); its predecessors connect to its successors, on the branch they led in with. */
export function removeStep(def: WorkflowDef, id: string): WorkflowDef {
  const gone = new Set([id, ...def.steps.filter((s) => s.loopId === id).map((s) => s.id)]);
  const into = def.edges.filter((e) => e.to === id);
  const out = def.edges.filter((e) => e.from === id).map((e) => e.to);
  const kept = def.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to));
  const bridged = into.flatMap(({ from, branch }) => out.map((to) => ({ from, to, ...(branch ? { branch } : {}) })));
  return { ...def, steps: def.steps.filter((s) => !gone.has(s.id)), edges: [...kept, ...bridged] };
}

/** The agents a workflow version puts to work. */
export function agentIdsOf(def: WorkflowDef): string[] {
  return [...new Set(nodesOf(def).flatMap((n) => (n.agentId ? [n.agentId] : [])))];
}

/** What a new workflow starts with: a Start button and no step. */
export function defaultWorkflowDef(triggerId: string): WorkflowDef {
  return { trigger: { type: "manual", field: { id: triggerId, key: "start", type: "button", label: "Start" } }, steps: [], edges: [] };
}
