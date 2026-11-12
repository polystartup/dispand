import type { AgentSnapshot } from "../db/schema.ts";
import { INTERACTION, type TriggerConfig } from "../triggers/model.ts";
import type { WorkflowDef } from "../workflows/model.ts";

// Pure: a Job's definition, in the shape the engine already runs.

/** The one step of a Job; with the trigger's id, a Job's step rows are predictable. */
export const JOB_STEP = "job";

/** What a primitive trigger's Job is told of its change, filled from the trigger node's outputs. */
export const CHANGE_PROMPT = [
  "The change that started this Job:",
  "- Operation: {{trigger.operation}}",
  "- Table: {{trigger.table_id}}",
  "- Row: {{trigger.row_id}}",
  "- Changed fields: {{trigger.changed_field_ids}}",
  "- Values before: {{trigger.before}}",
  "- Values after: {{trigger.after}}",
].join("\n");

/**
 * What a Job started by a Question or an Approval is told: its id, what happened and the asking
 * Job's ids and the item's kind (the event's values), never its text, options or answer.
 */
export const INTERACTION_PROMPT = [
  "The Question or Approval that started this Job:",
  "- What happened: {{trigger.operation}}",
  "- Item: {{trigger.row_id}}",
  "- Kind, and the Job that asked it: {{trigger.after}}",
].join("\n");

/** What every Job of the workspace's Assistant is told first, before the owner's own instructions. */
export const ASSISTANT_PROMPT = [
  "You are the Assistant of this Dispand workspace: the agent that knows how the platform works, how this workspace is configured, and the business it runs.",
  "You answer questions about the platform, the setup and the business by reading them through your tools, and you configure the workspace by proposing changes for the owner to approve.",
].join(" ");

/** An agent's system prompt in its Jobs: the Assistant's starts with its fixed text, then the owner's instructions. */
export function jobSystemPrompt(agent: { builtIn: string | null; systemPrompt: string }): string {
  if (agent.builtIn !== "assistant") return agent.systemPrompt;
  return agent.systemPrompt.trim() ? `${ASSISTANT_PROMPT}\n\n${agent.systemPrompt}` : ASSISTANT_PROMPT;
}

/** What a poll trigger's Job is told of its item, filled from the trigger node's outputs. */
export const POLL_PROMPT = ["The item that started this Job (id {{trigger.item_id}}):", "{{trigger.item}}"].join("\n");

/** A poll trigger node's outputs for one item: its id, and its content as JSON. */
export function pollOutputs(item: { itemId: string; content: string }): Record<string, string> {
  return { item_id: item.itemId, item: item.content };
}

/** A primitive trigger node's outputs for one event: ids as they are, the rest as JSON. */
export function eventOutputs(event: {
  tableId: string;
  rowId: string;
  operation: string;
  changedFieldIds: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}): Record<string, string> {
  return {
    operation: event.operation,
    table_id: event.tableId,
    row_id: event.rowId,
    changed_field_ids: JSON.stringify(event.changedFieldIds),
    before: JSON.stringify(event.before),
    after: JSON.stringify(event.after),
  };
}

/**
 * The definition of a Job: its trigger as the firing, then the agent with the trigger's
 * instructions as prompt. A chat placement has no step: the conversation is the Job.
 */
export function jobDef(input: {
  agent: AgentSnapshot;
  trigger: { id: string; name: string; config: TriggerConfig; instructions: string };
}): WorkflowDef {
  const { agent, trigger } = input;
  const { config } = trigger;
  const field = { id: trigger.id, key: "trigger", label: trigger.name };
  if (config.kind === "manual" && config.placement === "chat") {
    return {
      trigger: { type: "manual", field: { ...field, type: "chat", agentId: agent.id, prompt: trigger.instructions } },
      steps: [],
      edges: [],
    };
  }
  // A primitive trigger's change, or a poll's item, as its node's outputs, follows the instructions.
  const prompt =
    config.kind === "primitive"
      ? `${trigger.instructions}\n\n${config.tableId === INTERACTION ? INTERACTION_PROMPT : CHANGE_PROMPT}`
      : config.kind === "poll" ? `${trigger.instructions}\n\n${POLL_PROMPT}` : trigger.instructions;
  return {
    trigger:
      config.kind === "schedule"
        ? { type: "schedule", field: { ...field, type: "schedule", cron: config.cron, timezone: config.timezone } }
        : { type: "manual", field: { ...field, type: "button" } },
    steps: [{ id: JOB_STEP, key: JOB_STEP, type: "agent", name: agent.name, agentId: agent.id, prompt }],
    edges: [{ from: trigger.id, to: JOB_STEP }],
  };
}
