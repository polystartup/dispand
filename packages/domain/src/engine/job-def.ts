import type { AgentSnapshot } from "../db/schema.ts";
import type { TriggerConfig } from "../triggers/model.ts";
import type { WorkflowDef } from "../workflows/model.ts";

// Pure: a Job's definition, in the shape the engine already runs.

/** The one step of a Job; with the trigger's id, a Job's step rows are predictable. */
export const JOB_STEP = "job";

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
  return {
    trigger:
      config.kind === "schedule"
        ? { type: "schedule", field: { ...field, type: "schedule", cron: config.cron, timezone: config.timezone } }
        : { type: "manual", field: { ...field, type: "button" } },
    steps: [{ id: JOB_STEP, key: JOB_STEP, type: "agent", name: agent.name, agentId: agent.id, prompt: trigger.instructions }],
    edges: [{ from: trigger.id, to: JOB_STEP }],
  };
}
