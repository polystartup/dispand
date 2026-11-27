import { dataBlock, dataRule, dataTag } from "@dispand/runner-protocol";
import { nodesOf, type WorkflowDef } from "../workflows/model.ts";
import { renderTemplate } from "../workflows/template.ts";

// Every prompt filled from a run's values, with someone else's text in a block
// (`@dispand/runner-protocol`'s `data-block.ts`), and which values are someone else's.

/**
 * `prompt` filled in with `values` (`renderTemplate`), each value `others` names in a block, and the
 * rule after the prompt when there is one. Every prompt filled from a run's values goes through here.
 */
export function renderPrompt(
  prompt: string,
  values: Record<string, Record<string, string>>,
  others: (key: string, field: string) => boolean,
  tag = dataTag(),
): string {
  let blocks = false;
  const text = renderTemplate(prompt, values, (key, field, value) => (others(key, field) ? ((blocks = true), dataBlock(tag, value)) : value));
  return blocks ? `${text}\n\n${dataRule(tag)}` : text;
}

/**
 * The values of a Job's trigger the platform makes: ids it minted, and the names of its operations
 * and states. Every other value of a Job's trigger is someone else's text: a polled item and its id
 * (which the polled result names), a row's values, an agent's name, a consult's question, a plugin
 * update's values.
 */
export const PLATFORM_VALUES: readonly string[] = [
  "scheduled_for",
  "operation",
  "table_id",
  "row_id",
  "changed_field_ids",
  "job_id",
  "agent_id",
  "status",
  "asking_job_id",
];

/**
 * Which values a prompt of `def` reads are someone else's text, by `{{key.field}}`: of a Job's
 * trigger (`job`: `def` is a Job's, whose trigger is its firing), all but the platform's; a Tool
 * step's result and fields, and a data step's rows; a loop's item and its fields when its list is
 * such text, and its `results` when its body has a Tool or data step. Not a workflow's own trigger
 * (a schedule's time), a condition's verdict, a loop's `index` and `count`, nor an agent step's
 * outputs: those are the workflow's own chain, which its author means the next step to act on.
 */
export function othersValues(def: WorkflowDef, job: boolean): (key: string, field: string) => boolean {
  const nodes = nodesOf(def);
  const others = (nodeId: string, field: string): boolean => {
    if (nodes.find((n) => n.id === nodeId)?.kind === "trigger") return job && !PLATFORM_VALUES.includes(field);
    const step = def.steps.find((s) => s.id === nodeId);
    switch (step?.type) {
      case undefined:
      case "agent":
      case "condition":
        return false;
      case "data":
        // Its count and first row's id are the platform's; its rows are whoever wrote them.
        return field !== "count" && field !== "row_id";
      case "tool":
        return true;
      case "loop":
        if (field === "index" || field === "count") return false;
        // Loops don't nest (`validateWorkflow`): a body's steps are agent, condition, data and Tool steps.
        if (field === "results") return def.steps.some((s) => s.loopId === step.id && (s.type === "data" || s.type === "tool"));
        return step.list ? others(step.list.nodeId, step.list.name) : false;
    }
  };
  return (key, field) => {
    const node = nodes.find((n) => n.key === key);
    return node ? others(node.id, field) : false;
  };
}
