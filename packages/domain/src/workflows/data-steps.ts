import { OutputField } from "@dispand/runner-protocol";
import { parseCellText, type FieldSchema } from "../data/fields.ts";
import { FILTER_OPS, filterValue, takesValue, type FilterOp } from "../data/query.ts";
import type { WorkflowIssue } from "./derive.ts";
import { agentDriven, dataSources, nodesOf, readsOf, slugify, type DataStep, type Source, type Step, type WorkflowDef } from "./model.ts";

// Pure: imported by the web editor too (`@dispand/domain/workflows/data-steps`).

/**
 * What each data step action gives the steps after it. find-rows' `row_id` is the first match's
 * (`""` when none); its `rows` is JSON: `[{ "id": "…", "<field name>": "<cell as text>", … }]`.
 */
export const DATA_OUTPUTS = {
  "create-row": ["row_id"],
  "update-row": ["row_id"],
  "find-rows": ["count", "row_id", "rows"],
} as const satisfies Record<DataStep["action"], readonly string[]>;

/** A table as the workflow model sees it: what wiring, descriptions and checks need. */
export type TableSchema = { id: string; name: string; fields: FieldSchema[] };

/** Where a source goes in a data step: an input (by field), update-row's row id, or a filter (by position). */
export type DataTarget = { fieldId: string } | "rowId" | { filter: number };

function dataStepOf(def: WorkflowDef, stepId: string): DataStep | undefined {
  return def.steps.find((s): s is DataStep => s.id === stepId && s.type === "data");
}

function replaceStep(def: WorkflowDef, step: DataStep): WorkflowDef {
  return { ...def, steps: def.steps.map((s) => (s.id === step.id ? step : s)) };
}

/** The spec's default wiring: breadth-first over the links into `stepId`, the first chat or agent step met (ties: link order). */
export function nearestAgentNode(def: WorkflowDef, stepId: string): string | null {
  const nodes = new Map(nodesOf(def).map((n) => [n.id, n]));
  const seen = new Set([stepId]);
  let frontier = [stepId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of def.edges) {
        if (e.to !== id || seen.has(e.from)) continue;
        seen.add(e.from);
        const node = nodes.get(e.from);
        if (node && agentDriven(node)) return node.id;
        next.push(e.from);
      }
    }
    frontier = next;
  }
  return null;
}

/** An input a data or tool step wires to an upstream value: the field it sets or the parameter it fills. */
export type WiredInput = { step: Step; fieldId?: string; param?: string };

/**
 * The output name a new input asks of `nodeId`: `wanted` as an identifier, reused when only inputs
 * `same` accepts (the same field, the same parameter) already ask for it, else made unique with
 * `_2`, `_3`…
 */
export function outputNameFor(def: WorkflowDef, nodeId: string, wanted: string, same: (input: WiredInput) => boolean): string {
  // Each name `nodeId` is already asked for, and whether only inputs `same` accepts ask for it.
  const taken = new Map<string, boolean>();
  for (const node of nodesOf(def)) {
    const step = def.steps.find((s) => s.id === node.id);
    const inputs =
      step?.type === "data"
        ? dataSources(step).map((s) => ({ source: s.source, input: { step, ...(typeof s.target === "object" && "fieldId" in s.target ? { fieldId: s.target.fieldId } : {}) } }))
        : step?.type === "tool"
          ? step.inputs.map((i) => ({ source: i.source, input: { step, param: i.param } }))
          : null;
    if (inputs) {
      for (const { source, input } of inputs) {
        if (source.type !== "output" || source.nodeId !== nodeId) continue;
        taken.set(source.name, (taken.get(source.name) ?? true) && same(input));
      }
    } else {
      for (const ref of readsOf(def, node.id)) if (ref.nodeId === nodeId) taken.set(ref.name, false);
    }
  }
  let base = slugify(wanted);
  if (!OutputField.shape.name.safeParse(base).success) base = `f_${base}`.slice(0, 56);
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base}_${i}`;
    if (taken.get(name) !== false) return name;
  }
}

/**
 * Selects the fields a create-row or update-row step sets: inputs of fields still selected keep
 * their wiring, the others go, and each new one is wired to the nearest chat or agent step
 * upstream (or to a value to type when there is none). Files can't be set: attachment fields
 * are skipped. Choosing another table drops every input of the previous one.
 */
export function setDataFields(def: WorkflowDef, stepId: string, table: TableSchema, fieldIds: string[]): WorkflowDef {
  const step = dataStepOf(def, stepId);
  if (!step || step.action === "find-rows") return def;
  const kept = step.tableId === table.id ? step.inputs : [];
  const agent = nearestAgentNode(def, stepId);
  let next: WorkflowDef = replaceStep(def, { ...step, tableId: table.id, inputs: kept.filter((i) => fieldIds.includes(i.fieldId)) });
  for (const fieldId of new Set(fieldIds)) {
    const field = table.fields.find((f) => f.id === fieldId);
    const current = dataStepOf(next, stepId) as Exclude<DataStep, { action: "find-rows" }>;
    if (!field || field.type === "attachment" || current.inputs.some((i) => i.fieldId === fieldId)) continue;
    const same = (i: WiredInput) => i.step.type === "data" && i.step.tableId === table.id && i.fieldId === field.id;
    const source: Source = agent ? { type: "output", nodeId: agent, name: outputNameFor(next, agent, field.name, same) } : { type: "value", value: "" };
    next = replaceStep(next, { ...current, inputs: [...current.inputs, { fieldId, source }] });
  }
  const order = (id: string) => fieldIds.indexOf(id);
  const done = dataStepOf(next, stepId) as Exclude<DataStep, { action: "find-rows" }>;
  return replaceStep(next, { ...done, inputs: [...done.inputs].sort((a, b) => order(a.fieldId) - order(b.fieldId)) });
}

/** Rewires one input, update-row's row id or one filter's value. */
export function setSource(def: WorkflowDef, stepId: string, target: DataTarget, source: Source): WorkflowDef {
  const step = dataStepOf(def, stepId);
  if (!step) return def;
  if (target === "rowId") return step.action === "update-row" ? replaceStep(def, { ...step, rowId: source }) : def;
  if ("filter" in target) {
    if (step.action !== "find-rows" || step.filters[target.filter] === undefined) return def;
    return replaceStep(def, { ...step, filters: step.filters.map((f, i) => (i === target.filter ? { ...f, value: source } : f)) });
  }
  if (step.action === "find-rows") return def;
  return replaceStep(def, { ...step, inputs: step.inputs.map((i) => (i.fieldId === target.fieldId ? { ...i, source } : i)) });
}

/** The tables a workflow's data steps use. */
export function tableIdsOf(def: WorkflowDef): string[] {
  return [...new Set(def.steps.flatMap((s) => (s.type === "data" && s.tableId !== "" ? [s.tableId] : [])))];
}

/**
 * What keeps the data steps from running against the tables as they are now: no table or a
 * table that's gone, a field that's gone, holds files or is set twice, a literal that doesn't fit
 * its field, a filter its field's type doesn't have or without the value it needs, an update
 * without a row.
 */
export function validateDataSteps(def: WorkflowDef, tables: TableSchema[]): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  for (const step of def.steps) {
    if (step.type !== "data") continue;
    const add = (message: string) => issues.push({ nodeId: step.id, message });
    if (step.tableId === "") {
      add("Choose a table");
      continue;
    }
    const table = tables.find((t) => t.id === step.tableId);
    if (!table) {
      add("This step's table no longer exists");
      continue;
    }
    const fields = new Map(table.fields.map((f) => [f.id, f]));
    if (step.action === "update-row" && step.rowId.type === "value" && step.rowId.value.trim() === "") add("Choose the row to update");
    if (step.action === "find-rows") {
      for (const filter of step.filters) {
        const field = fields.get(filter.fieldId);
        if (!field) {
          add(`A field this step filters on no longer exists in ${table.name}`);
          continue;
        }
        if (!(FILTER_OPS[field.type] as readonly FilterOp[]).includes(filter.op)) {
          add(`“${field.name}” can't be filtered by “${filter.op}”`);
          continue;
        }
        if (!takesValue(filter.op) || filter.value?.type === "output") continue;
        const parsed = filterValue(field, { fieldId: field.id, op: filter.op, value: filter.value?.value ?? "" });
        if (!parsed.ok) add(`“${field.name}”: ${parsed.reason}`);
        else if (parsed.value === null) add(`“${field.name}”: a value is needed`);
      }
      continue;
    }
    const seen = new Set<string>();
    for (const input of step.inputs) {
      const field = fields.get(input.fieldId);
      if (!field) {
        add(`A field this step sets no longer exists in ${table.name}`);
        continue;
      }
      if (field.type === "attachment") {
        add(`“${field.name}” holds files, which a workflow can't set`);
        continue;
      }
      if (seen.has(field.id)) {
        add(`“${field.name}” is set twice`);
        continue;
      }
      seen.add(field.id);
      if (input.source.type !== "value") continue;
      const parsed = parseCellText(field, input.source.value);
      if (!parsed.ok) add(`“${field.name}”: ${parsed.reason}`);
    }
  }
  return issues;
}
