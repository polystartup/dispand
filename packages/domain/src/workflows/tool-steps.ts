import { type Message, say } from "../messages/index.ts";
import { actionOutputFields, actionParams, coerceValue } from "../tools/arguments.ts";
import type { ToolAction } from "../tools/mcp.ts";
import { nearestAgentNode, outputNameFor, type WiredInput } from "./data-steps.ts";
import type { WorkflowIssue } from "./derive.ts";
import { nodesOf, readsOf, type Source, type ToolStep, type WorkflowDef } from "./model.ts";

export { actionParams, typeHint, type ActionParam } from "../tools/arguments.ts";

// Pure: imported by the web editor too (`@dispand/domain/workflows/tool-steps`).

/** An installed tool as the workflow model sees it (from `tools.list`, or `loadToolSchemas`). `kind` is read as text. */
export type ToolSchema = { id: string; name: string; kind: string; actions: ToolAction[]; disabled?: string[] };

function toolStepOf(def: WorkflowDef, stepId: string): ToolStep | undefined {
  return def.steps.find((s): s is ToolStep => s.id === stepId && s.type === "tool");
}

function replaceStep(def: WorkflowDef, step: ToolStep): WorkflowDef {
  return { ...def, steps: def.steps.map((s) => (s.id === step.id ? step : s)) };
}

/** The tools a workflow's Tool steps use. */
export function toolIdsOf(def: WorkflowDef): string[] {
  return [...new Set(def.steps.flatMap((s) => (s.type === "tool" && s.toolId !== "" ? [s.toolId] : [])))];
}

/** The tool step's tool and action as they are now, when both still exist. */
export function actionOf(step: ToolStep, tools: ToolSchema[]): { tool: ToolSchema; action: ToolAction } | null {
  const tool = tools.find((t) => t.id === step.toolId);
  const action = tool?.disabled?.includes(step.action) ? undefined : tool?.actions.find((a) => a.name === step.action);
  return tool && action ? { tool, action } : null;
}

/** Picks the step's tool: its action and inputs start over. */
export function pickTool(def: WorkflowDef, stepId: string, toolId: string): WorkflowDef {
  const step = toolStepOf(def, stepId);
  if (!step || step.toolId === toolId) return def;
  return replaceStep(def, { ...step, toolId, action: "", inputs: [] });
}

/**
 * Picks the step's action: inputs for parameters it doesn't have go, and each required parameter
 * not wired yet is wired to the nearest chat or agent step upstream, which is asked for a value
 * named after the parameter (or to a value to type when there is none). Optional ones start unwired.
 */
export function pickAction(def: WorkflowDef, stepId: string, action: ToolAction): WorkflowDef {
  const step = toolStepOf(def, stepId);
  if (!step) return def;
  const params = actionParams(action);
  const kept = step.action === action.name ? step.inputs : [];
  let next = replaceStep(def, { ...step, action: action.name, inputs: kept.filter((i) => params.some((p) => p.name === i.param)) });
  const agent = nearestAgentNode(def, stepId);
  for (const param of params) {
    const current = toolStepOf(next, stepId)!;
    if (!param.required || current.inputs.some((i) => i.param === param.name)) continue;
    const same = (i: WiredInput) => i.step.type === "tool" && i.step.toolId === step.toolId && i.step.action === action.name && i.param === param.name;
    const source: Source = agent ? { type: "output", nodeId: agent, name: outputNameFor(next, agent, param.name, same) } : { type: "value", value: "" };
    next = replaceStep(next, { ...current, inputs: [...current.inputs, { param: param.name, source }] });
  }
  return next;
}

/** Wires one parameter (`null`: unwires it, for an optional one). */
export function setToolSource(def: WorkflowDef, stepId: string, param: string, source: Source | null): WorkflowDef {
  const step = toolStepOf(def, stepId);
  if (!step) return def;
  const others = step.inputs.filter((i) => i.param !== param);
  const at = step.inputs.findIndex((i) => i.param === param);
  if (source === null) return replaceStep(def, { ...step, inputs: others });
  const input = { param, source };
  return replaceStep(def, { ...step, inputs: at === -1 ? [...others, input] : step.inputs.map((i) => (i.param === param ? input : i)) });
}

/**
 * What keeps the Tool steps from running against the tools as they are now: no tool or action, a
 * tool that's gone or that runs on a runner, an action that's gone, a required parameter not
 * wired, an input for a parameter the action doesn't have or wired twice, a literal that doesn't
 * fit its parameter's type, and a reference to a field the action declares it doesn't give.
 */
export function validateToolSteps(def: WorkflowDef, tools: ToolSchema[]): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  for (const step of def.steps) {
    if (step.type !== "tool") continue;
    const add = (message: Message) => issues.push({ nodeId: step.id, message });
    if (step.toolId === "") {
      add(say("workflows.issue.chooseTool"));
      continue;
    }
    const tool = tools.find((t) => t.id === step.toolId);
    if (!tool) {
      add(say("workflows.issue.toolGone"));
      continue;
    }
    if (tool.kind !== "http") {
      add(say("workflows.issue.runnerTool"));
      continue;
    }
    if (step.action === "") {
      add(say("workflows.issue.chooseAction"));
      continue;
    }
    if (tool.disabled?.includes(step.action)) {
      add(say("workflows.issue.actionDisabled", { tool: tool.name, action: step.action }));
      continue;
    }
    const action = tool.actions.find((a) => a.name === step.action);
    if (!action) {
      add(say("workflows.issue.actionGone", { tool: tool.name, action: step.action }));
      continue;
    }
    const params = actionParams(action);
    const seen = new Set<string>();
    for (const input of step.inputs) {
      const param = params.find((p) => p.name === input.param);
      if (!param) add(say("workflows.issue.noParam", { action: action.name, param: input.param }));
      else if (seen.has(param.name)) add(say("workflows.issue.setTwice", { name: param.name }));
      else if (input.source.type === "value" && (param.type === "string" || input.source.value.trim() !== "")) {
        const coerced = coerceValue(param.type, input.source.value, param.name);
        if ("error" in coerced) add(coerced.error);
      }
      seen.add(input.param);
    }
    for (const param of params) {
      const input = step.inputs.find((i) => i.param === param.name);
      const blank = input?.source.type === "value" && param.type !== "string" && input.source.value.trim() === "";
      if (param.required && (!input || blank)) add(say("workflows.issue.needsValue", { param: param.name }));
    }
  }
  // A field the action's output schema doesn't name: the reader's issue.
  const nodes = nodesOf(def);
  for (const reader of nodes) {
    const reported = new Set<string>();
    for (const ref of readsOf(def, reader.id)) {
      const step = def.steps.find((s): s is ToolStep => s.id === ref.nodeId && s.type === "tool");
      const found = step && actionOf(step, tools);
      const fields = found && actionOutputFields(found.action);
      if (!step || !fields || ref.name === "result" || fields.includes(ref.name)) continue;
      const reference = `{{${step.key}.${ref.name}}}`;
      if (reported.has(reference)) continue;
      reported.add(reference);
      issues.push({ nodeId: reader.id, message: say("workflows.issue.noGive", { reference, step: step.key, field: ref.name }) });
    }
  }
  return issues;
}
