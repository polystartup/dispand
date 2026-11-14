import { expect, test } from "vitest";
import { ELEMENT_FIELDS } from "./overrides.ts";
import { classify, FIELD_CLASS, planElement } from "./update.ts";

test("every field a plugin gives an element has a class, so none changes unlisted", () => {
  for (const kind of ["agent", "tool", "trigger"] as const) expect(Object.keys(FIELD_CLASS[kind]).sort()).toEqual([...ELEMENT_FIELDS[kind].overridable].sort());
});

test("a change that lets an agent do more, or with less asking, is widening; text that steers it is wording; the rest is silent", () => {
  // Lists: gaining is widening, only losing is silent, except a skill lost, which is what the agent was told.
  expect(classify("agent", "toolIds", ["t1"], ["t1", "t2"])).toBe("widening");
  expect(classify("agent", "toolIds", ["t1", "t2"], ["t1"])).toBe("silent");
  expect(classify("agent", "toolIds", ["t1"], ["t2"])).toBe("widening");
  expect(classify("agent", "bundles", ["data"], ["data", "configure"])).toBe("widening");
  expect(classify("agent", "selfLearning", [], ["agent"])).toBe("widening");
  expect(classify("agent", "skillPackageIds", [], ["p1"])).toBe("widening");
  expect(classify("agent", "skillPackageIds", ["p1"], [])).toBe("wording");
  // Tables: every table, or one more.
  expect(classify("agent", "dataTables", ["a"], "all")).toBe("widening");
  expect(classify("agent", "dataTables", ["a"], ["a", "b"])).toBe("widening");
  expect(classify("agent", "dataTables", "all", ["a"])).toBe("silent");
  // Consults: one more, or one that no longer asks first.
  expect(classify("agent", "consults", [{ agentId: "a", ask: true }], [{ agentId: "a", ask: false }])).toBe("widening");
  expect(classify("agent", "consults", [{ agentId: "a", ask: false }], [{ agentId: "a", ask: true }])).toBe("silent");
  expect(classify("agent", "consults", [], [{ agentId: "a", ask: true }])).toBe("widening");
  for (const field of ["name", "description", "systemPrompt"]) expect(classify("agent", field, "a", "b")).toBe("wording");
  // A tool: where its calls go; its name is what agents call it by.
  expect(classify("tool", "url", "https://a.example/mcp", "https://b.example/mcp")).toBe("widening");
  expect(classify("tool", "transport", "sse", "streamable-http")).toBe("widening");
  expect(classify("tool", "name", "a", "b")).toBe("wording");
  // A trigger: what starts Jobs, how many at once, how many an hour.
  expect(classify("trigger", "config", { kind: "schedule", cron: "0 9 * * *" }, { kind: "schedule", cron: "* * * * *" })).toBe("widening");
  expect(classify("trigger", "concurrency", "one-at-a-time", "parallel")).toBe("widening");
  expect(classify("trigger", "concurrency", "parallel", "one-at-a-time")).toBe("silent");
  expect(classify("trigger", "rateCap", 60, 600)).toBe("widening");
  expect(classify("trigger", "rateCap", 60, 10)).toBe("silent");
  expect(classify("trigger", "instructions", "a", "b")).toBe("wording");
  expect(classify("trigger", "name", "a", "b")).toBe("silent");
});

test("an element's plan: what follows the plugin by class, and the owner's fields the plugin changed", () => {
  const element = { upstream: { name: "Drafting", systemPrompt: "Draft.", toolIds: ["t1"], bundles: ["data"] }, overridden: ["systemPrompt"] };
  const current = { name: "Drafting", systemPrompt: "Mine.", toolIds: ["t1"], bundles: ["data"] };
  const plan = planElement("agent", { id: "agent_1", name: "Drafting" }, element, current, { name: "Drafter", systemPrompt: "Draft well.", toolIds: ["t1", "t2"], bundles: [] });
  expect(plan.conflicts).toEqual([{ key: "agent:agent_1:systemPrompt", kind: "agent", id: "agent_1", name: "Drafting", field: "systemPrompt", old: "Draft.", mine: "Mine.", next: "Draft well." }]);
  expect(plan.changes).toEqual([
    { key: "agent:agent_1:name", kind: "agent", id: "agent_1", name: "Drafting", field: "name", class: "wording", before: "Drafting", after: "Drafter" },
    { key: "agent:agent_1:bundles", kind: "agent", id: "agent_1", name: "Drafting", field: "bundles", class: "silent", before: ["data"], after: [] },
    { key: "agent:agent_1:toolIds", kind: "agent", id: "agent_1", name: "Drafting", field: "toolIds", class: "widening", before: ["t1"], after: ["t1", "t2"] },
  ]);
  // Taking the plugin's value of a field in conflict moves it among what follows.
  const taken = planElement("agent", { id: "agent_1", name: "Drafting" }, element, current, { systemPrompt: "Draft well." }, ["systemPrompt"]);
  expect(taken.conflicts).toEqual([]);
  expect(taken.set).toEqual({ systemPrompt: "Draft well." });
});
