import { OutputField, SHORT } from "@dispand/runner-protocol";
import { typeHint } from "../data/fields.ts";
import { actionParams, typeHint as paramHint } from "../tools/arguments.ts";
import { CONDITION_OUTPUTS } from "./condition.ts";
import { DATA_OUTPUTS, type TableSchema } from "./data-steps.ts";
import { LOOP_OUTPUTS } from "./loop.ts";
import { branchProblem, dataSources, nodesOf, readsOf, upstreamOf, type WorkflowDef, type WorkflowNode } from "./model.ts";
import { storableText } from "../text.ts";
import { cronProblem, SCHEDULE_OUTPUTS } from "./schedule.ts";
import { actionOf, type ToolSchema } from "./tool-steps.ts";

export { upstreamOf };
import { references } from "./template.ts";

// Pure: imported by the web editor too (`@dispand/domain/workflows/derive`).

export type WorkflowIssue = { nodeId: string; message: string };

/** The most expected outputs a session takes (the protocol's bound). */
export const MAX_OUTPUTS = 100;

/** Whether `field` can be an expected output's name (the protocol's identifier rule). */
export function isOutputName(field: string): boolean {
  return OutputField.shape.name.safeParse(field).success;
}

/**
 * What a node gives `readerId`: an agent-driven node (chat, agent) gives whatever they reference
 * (each reference becomes an expected output); other nodes give a fixed list, but a loop to the
 * steps of its body (the item's fields, whatever they are) and a Tool step (`result` and its
 * result's fields, known only once it answers: `validateToolSteps` checks those its action declares).
 */
export function sourceFields(
  def: WorkflowDef,
  sourceId: string,
  readerId?: string,
): { kind: "agent" } | { kind: "fixed"; fields: string[] } | { kind: "open" } {
  const node = nodesOf(def).find((n) => n.id === sourceId);
  switch (node?.type) {
    case "chat":
    case "agent":
      return { kind: "agent" };
    case "button":
      return { kind: "fixed", fields: [] };
    case "condition":
      return { kind: "fixed", fields: [...CONDITION_OUTPUTS] };
    case "schedule":
      return { kind: "fixed", fields: [...SCHEDULE_OUTPUTS] };
    case "data": {
      const step = def.steps.find((s) => s.id === sourceId);
      return { kind: "fixed", fields: step?.type === "data" ? [...DATA_OUTPUTS[step.action]] : [] };
    }
    case "tool":
      return { kind: "open" };
    case "loop":
      return readerId !== undefined && def.steps.some((s) => s.id === readerId && s.loopId === sourceId)
        ? { kind: "open" }
        : { kind: "fixed", fields: [...LOOP_OUTPUTS] };
    case undefined:
      return { kind: "open" };
  }
}

/**
 * What a value a step reads is for, for its agent: a loop's list, the name, table and type of the
 * field a data step fills, or the description and type of the tool parameter it fills.
 */
function describe(def: WorkflowDef, tables: TableSchema[], tools: ToolSchema[], nodeId: string): Map<string, string> {
  const out = new Map<string, string>();
  const step = def.steps.find((s) => s.id === nodeId);
  if (step?.type === "loop" && step.list) out.set(`${step.list.nodeId}\u0000${step.list.name}`, "A JSON array of the items to loop over");
  if (step?.type === "tool") {
    const found = actionOf(step, tools);
    const params = found ? actionParams(found.action) : [];
    for (const { param: name, source } of step.inputs) {
      const param = params.find((p) => p.name === name);
      const key = `${source.type === "output" ? source.nodeId : ""}\u0000${source.type === "output" ? source.name : ""}`;
      if (source.type !== "output" || !param || out.has(key)) continue;
      const hint = paramHint(param.type);
      const what = param.description.trim() || `For “${param.name}” of ${found!.tool.name}`;
      // The protocol's bound on a description (a cut surrogate pair made storable).
      out.set(key, storableText(`${what}${hint ? ` (${hint})` : ""}`.slice(0, SHORT)));
    }
  }
  if (step?.type !== "data") return out;
  const table = tables.find((t) => t.id === step.tableId);
  if (!table) return out;
  for (const { target, fieldId, source } of dataSources(step)) {
    if (source.type !== "output") continue;
    const key = `${source.nodeId}\u0000${source.name}`;
    if (out.has(key)) continue;
    if (target === "rowId") out.set(key, `The id of a row of ${table.name}`);
    const field = table.fields.find((f) => f.id === fieldId);
    if (field) out.set(key, `For “${field.name}” in ${table.name}: ${typeHint(field)}`);
  }
  return out;
}

/**
 * Each node's expected outputs: every `{{key.field}}` in any prompt, every value a condition
 * compares, every loop's list and every value a data step is wired to adds `field` to the chat or agent step it
 * names, in order of first use (whose description it keeps: a data step's gives the field's name,
 * table and type, from `tables`; a Tool step's the parameter's description and type, from
 * `tools`). Moving a reference to another node moves the field with it.
 */
export function deriveExpectedOutputs(def: WorkflowDef, tables: TableSchema[] = [], tools: ToolSchema[] = []): Record<string, OutputField[]> {
  const nodes = nodesOf(def);
  const fields = new Map(nodes.map((n) => [n.id, [] as OutputField[]]));
  for (const node of nodes) {
    const descriptions = describe(def, tables, tools, node.id);
    for (const ref of readsOf(def, node.id)) {
      if (sourceFields(def, ref.nodeId).kind !== "agent" || !isOutputName(ref.name)) continue;
      const list = fields.get(ref.nodeId);
      if (!list || list.some((f) => f.name === ref.name)) continue;
      const description = descriptions.get(`${ref.nodeId}\u0000${ref.name}`);
      list.push({ name: ref.name, type: "string", ...(description ? { description } : {}) });
    }
  }
  return Object.fromEntries(fields);
}

/**
 * What the definition can't be saved with: duplicate node ids or keys, edges to nodes that don't
 * exist, cycles, links across a loop's edge, steps in a loop that doesn't exist or nested loops.
 * The editor never makes them; `workflows.update` refuses them.
 */
export function structuralIssues(def: WorkflowDef): WorkflowIssue[] {
  const nodes = nodesOf(def);
  const ids = new Set(nodes.map((n) => n.id));
  const issues: WorkflowIssue[] = [];
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  for (const node of nodes) {
    const add = (message: string) => issues.push({ nodeId: node.id, message });
    if (seenIds.has(node.id)) add("Another step has the same id");
    seenIds.add(node.id);
    if (seenKeys.has(node.key)) add(`Another step is also called “${node.key}”`);
    seenKeys.add(node.key);
    if (def.edges.some((e) => e.from === node.id && !ids.has(e.to))) add("This step leads to a step that doesn't exist");
    if (def.edges.some((e) => e.to === node.id && !ids.has(e.from))) add("This step follows a step that doesn't exist");
    if (upstreamOf(def, node.id).has(node.id)) add("This step is part of a loop");
    const problems = new Set(def.edges.filter((e) => e.from === node.id).map((e) => branchProblem(def, e.from, e.branch)));
    for (const problem of problems) if (problem) add(problem);
    const loop = node.loopId === undefined ? undefined : nodes.find((n) => n.id === node.loopId);
    if (node.loopId !== undefined && loop?.type !== "loop") add("This step's loop doesn't exist");
    else if (node.loopId !== undefined && node.type === "loop") add("Loops can't be nested yet");
    const scope = (id: string) => nodes.find((n) => n.id === id)?.loopId;
    if (def.edges.some((e) => e.from === node.id && ids.has(e.to) && scope(e.to) !== node.loopId)) add("A link can't cross the edge of a loop");
  }
  if (def.edges.some((e) => !ids.has(e.from) && !ids.has(e.to))) issues.push({ nodeId: "", message: "A link joins steps that don't exist" });
  return issues;
}

/** What keeps the workflow from running: the structural issues, steps without an agent, unknown or not-upstream references. */
export function validateWorkflow(def: WorkflowDef): WorkflowIssue[] {
  const expected = deriveExpectedOutputs(def);
  const nodes = nodesOf(def);
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const structural = structuralIssues(def);
  const issues: WorkflowIssue[] = structural.filter((i) => i.nodeId === "");
  for (const node of nodes) {
    const add = (message: string) => issues.push({ nodeId: node.id, message });
    if (node.agentId === "") add("Choose an agent");
    const t = def.trigger;
    if (t.type === "schedule" && t.field.id === node.id) {
      const problem = cronProblem(t.field.cron, t.field.timezone);
      if (problem) add(problem);
    }
    for (const i of structural) if (i.nodeId === node.id) issues.push(i);
    const upstream = upstreamOf(def, node.id);
    const reported = new Set<string>();
    const check = (source: WorkflowNode, field: string) => {
      const name = `{{${source.key}.${field}}}`;
      if (reported.has(name)) return;
      reported.add(name);
      const gives = sourceFields(def, source.id, node.id);
      const loop = source.loopId === undefined ? undefined : byId.get(source.loopId);
      if (loop && source.loopId !== node.loopId) {
        add(`${name}: “${source.key}” runs inside the loop “${loop.key}”: use {{${loop.key}.results}}`);
      } else if (source.id === node.id || !upstream.has(source.id)) add(`${name}: “${source.key}” doesn't run before this step`);
      else if (source.type === "button") add(`${name}: “${source.key}” is a button, it has no values`);
      else if (!isOutputName(field)) {
        add(`${name}: “${field}” can't name a value (letters, digits and _, not starting with a digit, at most 64, not a reserved name)`);
      } else if (gives.kind === "fixed" && !gives.fields.includes(field)) add(`${name}: “${source.key}” doesn't give “${field}”`);
    };
    for (const ref of references(node.prompt ?? "")) {
      const source = byKey.get(ref.key);
      if (source === undefined) add(`{{${ref.key}.${ref.field}}}: no step is called “${ref.key}”`);
      else check(source, ref.field);
    }
    const step = def.steps.find((s) => s.id === node.id);
    if (step?.type === "condition") {
      const source = step.value ? byId.get(step.value.nodeId) : undefined;
      if (step.value === null) add("Choose the value to compare");
      else if (source === undefined) add("The value to compare comes from a step that doesn't exist");
      else check(source, step.value.name);
    }
    if (step?.type === "loop") {
      const source = step.list ? byId.get(step.list.nodeId) : undefined;
      if (step.list === null) add("Choose the list to loop over");
      else if (source === undefined) add("The list comes from a step that doesn't exist");
      else check(source, step.list.name);
      if (!def.steps.some((s) => s.loopId === step.id)) add("Add a step inside this loop");
    }
    if (step?.type === "data" || step?.type === "tool") {
      for (const { source: ref } of step.type === "data" ? dataSources(step) : step.inputs) {
        if (ref.type !== "output") continue;
        const source = byId.get(ref.nodeId);
        if (source === undefined) add("A value comes from a step that doesn't exist");
        else check(source, ref.name);
      }
    }
    const outputs = expected[node.id]?.length ?? 0;
    if (outputs > MAX_OUTPUTS) add(`Later steps ask this step for ${outputs} values, at most ${MAX_OUTPUTS}`);
  }
  return issues;
}
