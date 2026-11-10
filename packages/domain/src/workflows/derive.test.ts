import { expect, test } from "vitest";
import { deriveExpectedOutputs, structuralIssues, validateWorkflow } from "./derive.ts";
import { addStep, renameNode, WorkflowDef, type AgentStep } from "./model.ts";

/** Chat "Brief" → step "Plan" → step "Build". */
function chain(planPrompt: string, buildPrompt: string): WorkflowDef {
  return {
    trigger: {
      type: "manual",
      field: { id: "n_chat", key: "brief", type: "chat", label: "Brief", agentId: "agent_1", prompt: "Ask what to build." },
    },
    steps: [
      { id: "n_plan", key: "plan", type: "agent", name: "Plan", agentId: "agent_1", prompt: planPrompt },
      { id: "n_build", key: "build", type: "agent", name: "Build", agentId: "agent_1", prompt: buildPrompt },
    ],
    edges: [
      { from: "n_chat", to: "n_plan" },
      { from: "n_plan", to: "n_build" },
    ],
  };
}

test("derive collects referenced fields per node", () => {
  const def = chain("Plan {{brief.idea}} for {{brief.audience}}.", "Build {{plan.architecture}} named {{brief.idea}}.");
  expect(deriveExpectedOutputs(def)).toEqual({
    n_chat: [
      { name: "idea", type: "string" },
      { name: "audience", type: "string" },
    ],
    n_plan: [{ name: "architecture", type: "string" }],
    n_build: [],
  });
});

test("derive updates when a reference moves to another node", () => {
  const before = chain("Plan {{brief.idea}}.", "Build {{brief.repo_name}}.");
  expect(deriveExpectedOutputs(before).n_chat).toContainEqual({ name: "repo_name", type: "string" });
  const after = chain("Plan {{brief.idea}}.", "Build {{plan.repo_name}}.");
  const outputs = deriveExpectedOutputs(after);
  expect(outputs.n_chat).toEqual([{ name: "idea", type: "string" }]);
  expect(outputs.n_plan).toEqual([{ name: "repo_name", type: "string" }]);
});

test("validate reports a reference to a downstream node", () => {
  const def = chain("Plan {{build.result}}.", "Build it.");
  expect(validateWorkflow(def)).toEqual([
    { nodeId: "n_plan", message: "{{build.result}}: “build” doesn't run before this step" },
  ]);
  expect(validateWorkflow(chain("Plan {{nobody.x}}.", "Build it."))).toEqual([
    { nodeId: "n_plan", message: "{{nobody.x}}: no step is called “nobody”" },
  ]);
  expect(validateWorkflow(chain("Plan {{brief.idea}}.", "Build {{plan.x}} {{brief.y}}."))).toEqual([]);
});

test("validate reports cycles and missing agents", () => {
  const def = chain("Plan.", "Build.");
  def.edges.push({ from: "n_build", to: "n_plan" });
  (def.steps[1] as AgentStep).agentId = "";
  expect(validateWorkflow(def)).toEqual([
    { nodeId: "n_plan", message: "This step is part of a loop" },
    { nodeId: "n_build", message: "Choose an agent" },
    { nodeId: "n_build", message: "This step is part of a loop" },
  ]);
});

test("rename rewrites references", () => {
  const def = chain("Plan {{brief.idea}}.", "Build {{plan.architecture}} from {{ plan.repo }}.");
  const renamed = renameNode(def, "n_plan", "Define software architecture");
  expect(renamed.steps[0]).toMatchObject({ name: "Define software architecture", key: "define_software_architecture" });
  expect((renamed.steps[1] as AgentStep).prompt).toBe(
    "Build {{define_software_architecture.architecture}} from {{define_software_architecture.repo}}.",
  );
  // The trigger renames through its label; a name another node has gets a suffix.
  const clash = renameNode(def, "n_chat", "Plan");
  expect(clash.trigger.field).toMatchObject({ label: "Plan", key: "plan_2" });
  expect((clash.steps[0] as AgentStep).prompt).toBe("Plan {{plan_2.idea}}.");
  expect(deriveExpectedOutputs(renamed).n_plan).toEqual([
    { name: "architecture", type: "string" },
    { name: "repo", type: "string" },
  ]);
});

test("addStep appends a step after the last one", () => {
  const def = addStep(chain("Plan.", "Build."), { after: "n_build" }, "n_new", "agent");
  expect(def.steps[2]).toEqual({ id: "n_new", key: "step_3", type: "agent", name: "Step 3", agentId: "", prompt: "" });
  expect(def.edges.at(-1)).toEqual({ from: "n_build", to: "n_new" });
});

test("validate refuses duplicate ids and edges to missing nodes", () => {
  const def = chain("Plan.", "Build.");
  def.steps[1]!.id = "n_plan";
  def.edges.push({ from: "n_ghost", to: "n_chat" }, { from: "n_x", to: "n_y" });
  // The second step took the first one's id: "n_build" is gone, and so is the edge's target.
  expect(structuralIssues(def)).toEqual([
    { nodeId: "n_chat", message: "This step follows a step that doesn't exist" },
    { nodeId: "n_plan", message: "This step leads to a step that doesn't exist" },
    { nodeId: "n_plan", message: "Another step has the same id" },
    { nodeId: "n_plan", message: "This step leads to a step that doesn't exist" },
    { nodeId: "", message: "A link joins steps that don't exist" },
  ]);
  expect(validateWorkflow(def)).toEqual(expect.arrayContaining(structuralIssues(def)));
});

test("a Button trigger has no values to reference", () => {
  const def: WorkflowDef = {
    trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } },
    steps: [{ id: "n_a", key: "a", type: "agent", name: "A", agentId: "agent_1", prompt: "Use {{go.x}}." }],
    edges: [{ from: "n_go", to: "n_a" }],
  };
  expect(validateWorkflow(def)).toEqual([{ nodeId: "n_a", message: "{{go.x}}: “go” is a button, it has no values" }]);
  expect(deriveExpectedOutputs(def)).toEqual({ n_go: [], n_a: [] });
});

test("a field that can't be an output name is an issue, not an expected output", () => {
  const def = chain("Plan {{brief.1st}} and {{brief.constructor}} and {{brief.idea}}.", "Build.");
  expect(deriveExpectedOutputs(def).n_chat).toEqual([{ name: "idea", type: "string" }]);
  expect(validateWorkflow(def).map((i) => i.message)).toEqual([
    "{{brief.1st}}: “1st” can't name a value (letters, digits and _, not starting with a digit, at most 64, not a reserved name)",
    "{{brief.constructor}}: “constructor” can't name a value (letters, digits and _, not starting with a digit, at most 64, not a reserved name)",
  ]);
});

test("a step asked for more values than a session takes is an issue", () => {
  const fields = Array.from({ length: 101 }, (_, i) => `{{brief.f${i}}}`).join(" ");
  const issues = validateWorkflow(chain(fields, "Build."));
  expect(issues).toEqual([{ nodeId: "n_chat", message: "Later steps ask this step for 101 values, at most 100" }]);
});

/** Chat "Brief" → condition "If" → step "Plan" on Then, with the condition on `brief.<field>`. */
function gated(field: string, planPrompt = "Plan."): WorkflowDef {
  const def = chain(planPrompt, "Build.");
  return {
    ...def,
    steps: [
      { id: "n_if", key: "if", type: "condition", name: "If", value: { type: "output", nodeId: "n_chat", name: field }, op: "equals", operand: "yes" },
      ...def.steps,
    ],
    edges: [
      { from: "n_chat", to: "n_if" },
      { from: "n_if", to: "n_plan", branch: "then" },
      { from: "n_plan", to: "n_build" },
    ],
  };
}

test("a condition on a chat field adds it to the chat's expected outputs", () => {
  expect(deriveExpectedOutputs(gated("approved"))).toEqual({
    n_chat: [{ name: "approved", type: "string" }],
    n_if: [],
    n_plan: [],
    n_build: [],
  });
  expect(validateWorkflow(gated("approved", "Plan if {{if.matched}}."))).toEqual([]);
});

test("a reference to a condition's other field is an issue", () => {
  const def = gated("approved", "Plan {{if.result}}.");
  expect(deriveExpectedOutputs(def).n_if).toEqual([]);
  expect(validateWorkflow(def)).toEqual([{ nodeId: "n_plan", message: "{{if.result}}: “if” doesn't give “result”" }]);
});

test("a condition needs an upstream value", () => {
  const none = gated("approved");
  none.steps[0] = { ...none.steps[0]!, value: null } as WorkflowDef["steps"][number];
  expect(validateWorkflow(none)).toEqual([{ nodeId: "n_if", message: "Choose the value to compare" }]);
  const downstream = gated("approved");
  downstream.steps[0] = { ...downstream.steps[0]!, value: { type: "output", nodeId: "n_build", name: "x" } } as WorkflowDef["steps"][number];
  expect(validateWorkflow(downstream)).toEqual([{ nodeId: "n_if", message: "{{build.x}}: “build” doesn't run before this step" }]);
});

test("an edge out of a condition needs a branch", () => {
  const def = gated("approved");
  def.edges[1] = { from: "n_if", to: "n_plan" };
  def.edges[2] = { from: "n_plan", to: "n_build", branch: "else" };
  expect(structuralIssues(def)).toEqual([
    { nodeId: "n_if", message: "Choose Then or Else for this link" },
    { nodeId: "n_plan", message: "Only a condition has Then and Else" },
  ]);
});

/** Schedule "Every morning" → step "Report", whose prompt is `prompt`. */
function scheduled(prompt: string, cron = "0 9 * * 1-5"): WorkflowDef {
  return {
    trigger: {
      type: "schedule",
      field: { id: "n_s", key: "every_morning", type: "schedule", label: "Every morning", cron, timezone: "Europe/Paris" },
    },
    steps: [{ id: "n_r", key: "report", type: "agent", name: "Report", agentId: "agent_1", prompt }],
    edges: [{ from: "n_s", to: "n_r" }],
  };
}

test("a schedule trigger gives scheduled_for and nothing else", () => {
  const def = scheduled("Report for {{every_morning.scheduled_for}}.");
  expect(WorkflowDef.parse(def)).toEqual(def);
  expect(validateWorkflow(def)).toEqual([]);
  expect(deriveExpectedOutputs(def)).toEqual({ n_s: [], n_r: [] });
  expect(validateWorkflow(scheduled("Report {{every_morning.topic}}."))).toEqual([
    { nodeId: "n_r", message: "{{every_morning.topic}}: “every_morning” doesn't give “topic”" },
  ]);
});

test("a schedule that can't be read is an issue on the trigger", () => {
  expect(validateWorkflow(scheduled("Report.", "0 0 9 * * *"))).toEqual([
    { nodeId: "n_s", message: "Use 5 fields: minute hour day month weekday" },
  ]);
});

test("a schedule trigger renames like any node", () => {
  const renamed = renameNode(scheduled("Report for {{every_morning.scheduled_for}}."), "n_s", "Daily");
  expect(renamed.trigger).toMatchObject({ type: "schedule", field: { label: "Daily", key: "daily", cron: "0 9 * * 1-5" } });
  expect((renamed.steps[0] as AgentStep).prompt).toBe("Report for {{daily.scheduled_for}}.");
});

/** Chat "Brief" → loop "each" over `brief.repos` (body: fetch → sum) → report. */
function loopDef(fetchPrompt: string, reportPrompt = "Report {{each.results}}."): WorkflowDef {
  return {
    trigger: { type: "manual", field: { id: "n_chat", key: "brief", type: "chat", label: "Brief", agentId: "agent_1", prompt: "Ask." } },
    steps: [
      { id: "n_each", key: "each", type: "loop", name: "Each", list: { type: "output", nodeId: "n_chat", name: "repos" }, maxIterations: 20 },
      { id: "n_fetch", key: "fetch", type: "agent", name: "Fetch", agentId: "agent_1", prompt: fetchPrompt, loopId: "n_each" },
      { id: "n_sum", key: "sum", type: "agent", name: "Sum", agentId: "agent_1", prompt: "Sum {{fetch.title}}.", loopId: "n_each" },
      { id: "n_report", key: "report", type: "agent", name: "Report", agentId: "agent_1", prompt: reportPrompt },
    ],
    edges: [
      { from: "n_chat", to: "n_each" },
      { from: "n_fetch", to: "n_sum" },
      { from: "n_each", to: "n_report" },
    ],
  };
}

test("a body step may reference {{each.item}} and the loop's upstream", () => {
  const def = loopDef("Fetch {{each.item}} ({{each.name}}, {{each.index}}) for {{brief.audience}}.");
  expect(validateWorkflow(def)).toEqual([]);
  expect(deriveExpectedOutputs(def)).toEqual({
    n_chat: [
      { name: "repos", type: "string", description: "A JSON array of the items to loop over" },
      { name: "audience", type: "string" },
    ],
    n_each: [],
    n_fetch: [{ name: "title", type: "string" }],
    n_sum: [],
    n_report: [],
  });
});

test("outside the body, a loop gives count and results", () => {
  expect(validateWorkflow(loopDef("Fetch.", "Report {{each.count}} {{each.results}} {{each.item}}."))).toEqual([
    { nodeId: "n_report", message: "{{each.item}}: “each” doesn't give “item”" },
  ]);
});

test("outside the body, a reference to a body node is an issue", () => {
  expect(validateWorkflow(loopDef("Fetch.", "Report {{fetch.title}}."))).toEqual([
    { nodeId: "n_report", message: "{{fetch.title}}: “fetch” runs inside the loop “each”: use {{each.results}}" },
  ]);
});

test("a loop needs a list and a body", () => {
  const def = loopDef("Fetch.");
  def.steps[0] = { ...def.steps[0], list: null } as WorkflowDef["steps"][number];
  def.steps = def.steps.filter((s) => s.loopId === undefined);
  def.edges = def.edges.filter((e) => e.from !== "n_fetch");
  expect(validateWorkflow(def)).toEqual([
    { nodeId: "n_each", message: "Choose the list to loop over" },
    { nodeId: "n_each", message: "Add a step inside this loop" },
  ]);
});

test("an edge across a loop's edge is an issue", () => {
  const def = loopDef("Fetch.");
  def.edges.push({ from: "n_sum", to: "n_report" });
  expect(structuralIssues(def)).toEqual([{ nodeId: "n_sum", message: "A link can't cross the edge of a loop" }]);
});

test("a nested loop is an issue, and so is a step in a loop that doesn't exist", () => {
  const def = loopDef("Fetch.");
  def.steps.push({ id: "n_in", key: "inner", type: "loop", name: "Inner", list: null, maxIterations: 5, loopId: "n_each" });
  def.steps.push({ id: "n_lost", key: "lost", type: "agent", name: "Lost", agentId: "agent_1", prompt: "", loopId: "n_report" });
  expect(structuralIssues(def)).toEqual([
    { nodeId: "n_in", message: "Loops can't be nested yet" },
    { nodeId: "n_lost", message: "This step's loop doesn't exist" },
  ]);
});
