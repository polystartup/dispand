import { expect, test } from "vitest";
import type { AgentSnapshot } from "../db/schema.ts";
import type { TriggerConfig } from "../triggers/model.ts";
import { validateWorkflow } from "../workflows/derive.ts";
import { jobDef } from "./job-def.ts";

const agent: AgentSnapshot = { id: "agent_1", name: "Clerk", harnessId: "harness_1", systemPrompt: "Be brief.", skills: [], tools: [] };
const trigger = (config: TriggerConfig) => ({ id: "trigger_1", name: "Morning mail", config, instructions: "Sort the mail." });

test("a button trigger gives a trigger node and one agent step joined by an edge", () => {
  expect(jobDef({ agent, trigger: trigger({ kind: "manual", placement: "button" }) })).toEqual({
    trigger: { type: "manual", field: { id: "trigger_1", key: "trigger", type: "button", label: "Morning mail" } },
    steps: [{ id: "job", key: "job", type: "agent", name: "Clerk", agentId: "agent_1", prompt: "Sort the mail." }],
    edges: [{ from: "trigger_1", to: "job" }],
  });
});

test("a chat trigger gives a chat field bound to the agent with the instructions as prompt, and no step", () => {
  expect(jobDef({ agent, trigger: trigger({ kind: "manual", placement: "chat" }) })).toEqual({
    trigger: {
      type: "manual",
      field: { id: "trigger_1", key: "trigger", type: "chat", label: "Morning mail", agentId: "agent_1", prompt: "Sort the mail." },
    },
    steps: [],
    edges: [],
  });
});

test("a schedule trigger gives a schedule field with cron and timezone", () => {
  const def = jobDef({ agent, trigger: trigger({ kind: "schedule", cron: "0 9 * * *", timezone: "Europe/Paris" }) });
  expect(def.trigger).toEqual({
    type: "schedule",
    field: { id: "trigger_1", key: "trigger", type: "schedule", label: "Morning mail", cron: "0 9 * * *", timezone: "Europe/Paris" },
  });
  expect(def.steps).toHaveLength(1);
  expect(def.edges).toEqual([{ from: "trigger_1", to: "job" }]);
});

test("validateWorkflow accepts every def it produces", () => {
  const configs: TriggerConfig[] = [
    { kind: "manual", placement: "button" },
    { kind: "manual", placement: "chat" },
    { kind: "schedule", cron: "0 9 * * *", timezone: "Europe/Paris" },
  ];
  for (const config of configs) {
    expect(validateWorkflow(jobDef({ agent, trigger: trigger(config) }))).toEqual([]);
    expect(validateWorkflow(jobDef({ agent, trigger: { ...trigger(config), instructions: "" } }))).toEqual([]);
  }
});
