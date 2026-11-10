import { expect, test } from "vitest";
import type { ToolAction } from "../tools/mcp.ts";
import { deriveExpectedOutputs, validateWorkflow } from "./derive.ts";
import { addStep, ToolStep, type WorkflowDef } from "./model.ts";
import { pickAction, pickTool, setToolSource, toolIdsOf, validateToolSteps, type ToolSchema } from "./tool-steps.ts";

const createRepository: ToolAction = {
  name: "create_repository",
  description: "Create a repository",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string", description: "Repository name" }, private: { type: "boolean" }, count: { type: "integer" } },
    required: ["name"],
  },
};
const github: ToolSchema = { id: "tool_gh", name: "GitHub", kind: "http", actions: [createRepository] };

/** Chat "Brief" → Tool "GitHub" (no tool yet), and a parallel agent "Arch" after the chat that the Tool step follows too. */
function chatThenTool(): WorkflowDef {
  return {
    trigger: { type: "manual", field: { id: "n_chat", key: "brief", type: "chat", label: "Brief", agentId: "agent_1", prompt: "Ask what to build." } },
    steps: [
      { id: "n_arch", key: "arch", type: "agent", name: "Arch", agentId: "agent_1", prompt: "Define the stack." },
      { id: "n_tool", key: "github", type: "tool", name: "GitHub", toolId: "", action: "", inputs: [] },
    ],
    edges: [
      { from: "n_chat", to: "n_tool" },
      { from: "n_chat", to: "n_arch" },
      { from: "n_arch", to: "n_tool" },
    ],
  };
}

const toolStep = (def: WorkflowDef) => def.steps.find((s): s is ToolStep => s.type === "tool")!;
const picked = () => pickAction(pickTool(chatThenTool(), "n_tool", "tool_gh"), "n_tool", createRepository);

test("addStep adds an empty Tool step", () => {
  const def = addStep(chatThenTool(), { after: "n_tool" }, "n_new", "tool");
  expect(def.steps.at(-1)).toEqual({ id: "n_new", key: "tool_3", name: "Tool 3", type: "tool", toolId: "", action: "", inputs: [] });
});

test("picking an action wires its required parameter to the chat", () => {
  const def = picked();
  expect(toolStep(def)).toMatchObject({ toolId: "tool_gh", action: "create_repository", inputs: [{ param: "name", source: { type: "output", nodeId: "n_chat", name: "name" } }] });
  // The chat's expected outputs gain `name`, with the parameter's description (tour step 18).
  expect(deriveExpectedOutputs(def, [], [github]).n_chat).toEqual([{ name: "name", type: "string", description: "Repository name" }]);
  expect(validateToolSteps(def, [github])).toEqual([]);
  expect(validateWorkflow(def)).toEqual([]);
});

test("rewiring the parameter to an agent step moves the field", () => {
  const def = setToolSource(picked(), "n_tool", "name", { type: "output", nodeId: "n_arch", name: "name" });
  const outputs = deriveExpectedOutputs(def, [], [github]);
  expect(outputs.n_chat).toEqual([]);
  expect(outputs.n_arch).toEqual([{ name: "name", type: "string", description: "Repository name" }]);
});

test("a wired optional parameter's type reaches the description", () => {
  const def = setToolSource(picked(), "n_tool", "private", { type: "output", nodeId: "n_chat", name: "private" });
  expect(deriveExpectedOutputs(def, [], [github]).n_chat?.[1]).toEqual({ name: "private", type: "string", description: "For “private” of GitHub (true or false)" });
});

test("a name another input already asks the chat for gets a suffix", () => {
  const base = chatThenTool();
  const asked: WorkflowDef = { ...base, steps: base.steps.map((s) => (s.id === "n_arch" ? { ...s, prompt: "Use {{brief.name}}." } : s)) };
  const def = pickAction(pickTool(asked, "n_tool", "tool_gh"), "n_tool", createRepository);
  expect(toolStep(def).inputs[0]!.source).toEqual({ type: "output", nodeId: "n_chat", name: "name_2" });
});

test("picking another action drops the inputs it doesn't have; another tool starts over", () => {
  const withExtra = setToolSource(picked(), "n_tool", "private", { type: "value", value: "true" });
  const other: ToolAction = { name: "list_issues", description: "", inputSchema: { properties: { private: { type: "boolean" } } } };
  expect(toolStep(pickAction(withExtra, "n_tool", other)).inputs).toEqual([]);
  expect(toolStep(pickAction(withExtra, "n_tool", createRepository)).inputs).toHaveLength(2);
  expect(toolStep(pickTool(withExtra, "n_tool", "tool_other"))).toMatchObject({ toolId: "tool_other", action: "", inputs: [] });
  expect(toolStep(setToolSource(withExtra, "n_tool", "private", null)).inputs.map((i) => i.param)).toEqual(["name"]);
});

test("validateToolSteps reports what keeps a Tool step from running", () => {
  const issues = (def: WorkflowDef, tools: ToolSchema[] = [github]) => validateToolSteps(def, tools).map((i) => i.message);
  expect(issues(chatThenTool())).toEqual(["Choose a tool"]);
  expect(issues(pickTool(chatThenTool(), "n_tool", "tool_gh"))).toEqual(["Choose an action"]);
  expect(issues(picked(), [])).toEqual(["This step's tool no longer exists"]);
  expect(issues(picked(), [{ ...github, kind: "runner" }])).toEqual(["Tool steps run HTTP tools; use an agent for runner tools"]);
  expect(issues(picked(), [{ ...github, actions: [] }])).toEqual(["GitHub no longer has the action “create_repository”"]);
  expect(issues(setToolSource(picked(), "n_tool", "name", null))).toEqual(["“name” needs a value"]);
  expect(issues(setToolSource(picked(), "n_tool", "gone", { type: "value", value: "x" }))).toEqual(["“create_repository” has no parameter “gone”"]);
  expect(issues(setToolSource(picked(), "n_tool", "count", { type: "value", value: "1.5" }))).toEqual(["“count” must be a whole number"]);
  // An empty literal for an optional non-text parameter is no value: fine.
  expect(issues(setToolSource(picked(), "n_tool", "count", { type: "value", value: "" }))).toEqual([]);
});

test("a reference to a tool's result is allowed, to a field its output schema doesn't name an issue", () => {
  const withSchema: ToolSchema = { ...github, actions: [{ ...createRepository, outputSchema: { type: "object", properties: { html_url: { type: "string" } } } }] };
  const base = picked();
  const def: WorkflowDef = {
    ...base,
    steps: [...base.steps, { id: "n_note", key: "note", type: "agent", name: "Note", agentId: "agent_1", prompt: "{{github.result}} {{github.html_url}} {{github.ssh_url}}" }],
    edges: [...base.edges, { from: "n_tool", to: "n_note" }],
  };
  expect(validateToolSteps(def, [withSchema])).toEqual([{ nodeId: "n_note", message: "{{github.ssh_url}}: “github” doesn't give “ssh_url”" }]);
  // Without an output schema, the fields are only known once the tool answers.
  expect(validateToolSteps(def, [github])).toEqual([]);
  expect(validateWorkflow(def)).toEqual([]);
});

test("a tool parameter wired to a step that doesn't run before it is an issue", () => {
  const def = setToolSource(picked(), "n_tool", "name", { type: "output", nodeId: "n_tool", name: "x" });
  expect(validateWorkflow(def).map((i) => i.message)).toEqual(["{{github.x}}: “github” doesn't run before this step"]);
});

test("toolIdsOf lists each picked tool once", () => {
  const def = addStep(picked(), { after: "n_tool" }, "n_t2", "tool");
  expect(toolIdsOf(pickTool(def, "n_t2", "tool_gh"))).toEqual(["tool_gh"]);
});

test("a Tool step's strings must be storable", () => {
  const step = { ...toolStep(picked()) };
  expect(ToolStep.safeParse({ ...step, action: "a\u0000b" }).success).toBe(false);
  expect(ToolStep.safeParse({ ...step, toolId: "\uD800" }).success).toBe(false);
  expect(ToolStep.safeParse({ ...step, inputs: [{ param: "p\u0000", source: { type: "value", value: "" } }] }).success).toBe(false);
  expect(ToolStep.safeParse({ ...step, inputs: [{ param: "", source: { type: "value", value: "" } }] }).success).toBe(false);
  expect(ToolStep.safeParse(step).success).toBe(true);
});
