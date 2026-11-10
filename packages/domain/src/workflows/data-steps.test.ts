import { expect, test } from "vitest";
import { nearestAgentNode, setDataFields, setSource, tableIdsOf, validateDataSteps, type TableSchema } from "./data-steps.ts";
import { deriveExpectedOutputs, validateWorkflow } from "./derive.ts";
import { addStep, renameNode, WorkflowDef, type DataStep } from "./model.ts";

const projects: TableSchema = {
  id: "t_projects",
  name: "Projects",
  fields: [
    { id: "f_name", name: "Name", type: "text", choices: [] },
    { id: "f_price", name: "Price", type: "number", choices: [] },
    { id: "f_photo", name: "Photo", type: "attachment", choices: [] },
    {
      id: "f_status",
      name: "Status",
      type: "single-select",
      choices: [
        { id: "c_idea", label: "Idea" },
        { id: "c_live", label: "Live" },
      ],
    },
  ],
};

/** Chat "Brief" → agent "Arch" → data "Create project" (create row on Projects: Name ← brief.name, Price ← brief.price). */
function chatThenData(): WorkflowDef {
  return {
    trigger: {
      type: "manual",
      field: { id: "n_chat", key: "brief", type: "chat", label: "Brief", agentId: "agent_1", prompt: "Ask what to build." },
    },
    steps: [
      { id: "n_arch", key: "arch", type: "agent", name: "Arch", agentId: "agent_1", prompt: "Design it." },
      {
        id: "n_data",
        key: "create_project",
        type: "data",
        name: "Create project",
        action: "create-row",
        tableId: "t_projects",
        inputs: [
          { fieldId: "f_name", source: { type: "output", nodeId: "n_chat", name: "name" } },
          { fieldId: "f_price", source: { type: "output", nodeId: "n_chat", name: "price" } },
        ],
      },
    ],
    edges: [
      { from: "n_chat", to: "n_arch" },
      { from: "n_arch", to: "n_data" },
    ],
  };
}

function dataStep(def: WorkflowDef, id = "n_data"): DataStep {
  return def.steps.find((s): s is DataStep => s.id === id && s.type === "data")!;
}

function withStep(def: WorkflowDef, step: DataStep): WorkflowDef {
  return { ...def, steps: def.steps.map((s) => (s.id === step.id ? step : s)) };
}

test("data inputs wired to the chat become its expected outputs, with their field's type", () => {
  expect(deriveExpectedOutputs(chatThenData(), [projects])["n_chat"]).toEqual([
    { name: "name", type: "string", description: "For “Name” in Projects: text" },
    { name: "price", type: "string", description: "For “Price” in Projects: a number" },
  ]);
  // Without the tables (or for a table that's gone), the names stay, without a description.
  expect(deriveExpectedOutputs(chatThenData())["n_chat"]).toEqual([
    { name: "name", type: "string" },
    { name: "price", type: "string" },
  ]);
  expect(deriveExpectedOutputs(chatThenData(), [projects])["n_data"]).toEqual([]);
  expect(validateWorkflow(chatThenData())).toEqual([]);
});

test("rewiring an input moves its output from one agent to the other", () => {
  const moved = setSource(chatThenData(), "n_data", { fieldId: "f_name" }, { type: "output", nodeId: "n_arch", name: "repo_name" });
  const out = deriveExpectedOutputs(moved, [projects]);
  expect(out["n_chat"]!.map((o) => o.name)).toEqual(["price"]);
  expect(out["n_arch"]!.map((o) => o.name)).toEqual(["repo_name"]);
});

test("a prompt reference's output keeps its first use; a data input's description fills it only when first", () => {
  const def = chatThenData();
  def.steps[0] = { ...def.steps[0]!, prompt: "Design {{brief.price}}." } as WorkflowDef["steps"][number];
  expect(deriveExpectedOutputs(def, [projects])["n_chat"]).toEqual([
    { name: "price", type: "string" },
    { name: "name", type: "string", description: "For “Name” in Projects: text" },
  ]);
});

test("an update-row's row id and a find-rows' filter values become expected outputs", () => {
  const def = chatThenData();
  const update = withStep(def, { ...dataStep(def), action: "update-row", rowId: { type: "output", nodeId: "n_arch", name: "row" } } as DataStep);
  expect(deriveExpectedOutputs(update, [projects])["n_arch"]).toEqual([
    { name: "row", type: "string", description: "The id of a row of Projects" },
  ]);
  const find = withStep(def, {
    id: "n_data",
    key: "create_project",
    type: "data",
    name: "Find",
    action: "find-rows",
    tableId: "t_projects",
    filters: [{ fieldId: "f_price", op: ">", value: { type: "output", nodeId: "n_chat", name: "budget" } }],
    limit: 20,
  });
  expect(deriveExpectedOutputs(find, [projects])["n_chat"]).toEqual([
    { name: "budget", type: "string", description: "For “Price” in Projects: a number" },
  ]);
  expect(tableIdsOf(find)).toEqual(["t_projects"]);
});

test("setDataFields wires new inputs to the nearest agent-driven step", () => {
  const def = addStep(chatThenData(), { after: "n_data" }, "n_new", "data");
  expect(dataStep(def, "n_new")).toEqual({
    id: "n_new",
    key: "data_3",
    type: "data",
    name: "Data 3",
    action: "create-row",
    tableId: "",
    inputs: [],
  });
  expect(nearestAgentNode(def, "n_new")).toBe("n_arch");
  const wired = setDataFields(def, "n_new", projects, ["f_status"]);
  expect(dataStep(wired, "n_new")).toMatchObject({
    tableId: "t_projects",
    inputs: [{ fieldId: "f_status", source: { type: "output", nodeId: "n_arch", name: "status" } }],
  });

  // Button → data: no agent upstream, so a value to type.
  const button: WorkflowDef = {
    trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } },
    steps: [],
    edges: [],
  };
  const lone = setDataFields(addStep(button, { after: "n_go" }, "n_d", "data"), "n_d", projects, ["f_name"]);
  expect(nearestAgentNode(lone, "n_d")).toBeNull();
  expect(dataStep(lone, "n_d").type === "data" && dataStep(lone, "n_d")).toMatchObject({
    inputs: [{ fieldId: "f_name", source: { type: "value", value: "" } }],
  });
});

test("setDataFields keeps existing wiring and skips attachment fields", () => {
  const def = setSource(chatThenData(), "n_data", { fieldId: "f_name" }, { type: "output", nodeId: "n_chat", name: "title" });
  const next = setDataFields(def, "n_data", projects, ["f_name", "f_photo", "f_status"]);
  expect(dataStep(next)).toMatchObject({
    inputs: [
      { fieldId: "f_name", source: { type: "output", nodeId: "n_chat", name: "title" } },
      { fieldId: "f_status", source: { type: "output", nodeId: "n_arch", name: "status" } },
    ],
  });
});

test("setDataFields makes a new output name unique on its node, unless the same field already uses it", () => {
  const def = chatThenData();
  def.steps[0] = { ...def.steps[0]!, prompt: "Design." } as WorkflowDef["steps"][number];
  // The chat already gives `name` for Projects' Name: a second data step on that field reuses it.
  const second = setDataFields(addStep(def, { edge: { from: "n_chat", to: "n_arch" } }, "n_d2", "data"), "n_d2", projects, ["f_name"]);
  expect(dataStep(second, "n_d2")).toMatchObject({ inputs: [{ source: { nodeId: "n_chat", name: "name" } }] });
  // Another table's "Name" field gets `name_2`.
  const other: TableSchema = { id: "t_other", name: "Other", fields: [{ id: "f_other", name: "Name", type: "text", choices: [] }] };
  const third = setDataFields(addStep(def, { edge: { from: "n_chat", to: "n_arch" } }, "n_d3", "data"), "n_d3", other, ["f_other"]);
  expect(dataStep(third, "n_d3")).toMatchObject({ inputs: [{ source: { nodeId: "n_chat", name: "name_2" } }] });
  // A field name that can't be an output name as it is still gives one.
  const odd: TableSchema = { id: "t_odd", name: "Odd", fields: [{ id: "f_1", name: "1st", type: "text", choices: [] }, { id: "f_2", name: "Constructor", type: "text", choices: [] }] };
  const named = setDataFields(addStep(def, { edge: { from: "n_chat", to: "n_arch" } }, "n_d4", "data"), "n_d4", odd, ["f_1", "f_2"]);
  expect(dataStep(named, "n_d4").type === "data" && dataStep(named, "n_d4")).toMatchObject({
    inputs: [{ source: { name: "f_1st" } }, { source: { name: "f_constructor" } }],
  });
});

test("a reference to a data step's output is not an expected output", () => {
  const def = addStep(chatThenData(), { after: "n_data" }, "n_next", "agent");
  def.steps[2] = { ...def.steps[2]!, agentId: "agent_1", prompt: "Use {{create_project.row_id}}." } as WorkflowDef["steps"][number];
  expect(deriveExpectedOutputs(def, [projects])["n_data"]).toEqual([]);
  expect(validateWorkflow(def)).toEqual([]);
  def.steps[2] = { ...def.steps[2]!, prompt: "Use {{create_project.nope}}." } as WorkflowDef["steps"][number];
  expect(validateWorkflow(def)).toEqual([{ nodeId: "n_next", message: "{{create_project.nope}}: “create_project” doesn't give “nope”" }]);
});

test("validate reports a source that isn't upstream, on a button, or a name a data step doesn't give", () => {
  const def = addStep(chatThenData(), { after: "n_data" }, "n_next", "agent");
  def.steps[2] = { ...def.steps[2]!, agentId: "agent_1" } as WorkflowDef["steps"][number];
  const downstream = setSource(def, "n_data", { fieldId: "f_name" }, { type: "output", nodeId: "n_next", name: "x" });
  expect(validateWorkflow(downstream)).toEqual([{ nodeId: "n_data", message: "{{step_3.x}}: “step_3” doesn't run before this step" }]);
  const gone = setSource(def, "n_data", { fieldId: "f_name" }, { type: "output", nodeId: "n_ghost", name: "x" });
  expect(validateWorkflow(gone)).toEqual([{ nodeId: "n_data", message: "A value comes from a step that doesn't exist" }]);
  const second = setDataFields(addStep(def, { after: "n_data" }, "n_d2", "data"), "n_d2", projects, ["f_name"]);
  const fromData = setSource(second, "n_d2", { fieldId: "f_name" }, { type: "output", nodeId: "n_data", name: "count" });
  expect(validateWorkflow(fromData)).toEqual([{ nodeId: "n_d2", message: "{{create_project.count}}: “create_project” doesn't give “count”" }]);
  const button: WorkflowDef = {
    trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } },
    steps: [],
    edges: [],
  };
  const fromButton = setSource(setDataFields(addStep(button, { after: "n_go" }, "n_d", "data"), "n_d", projects, ["f_name"]), "n_d", { fieldId: "f_name" }, { type: "output", nodeId: "n_go", name: "x" });
  expect(validateWorkflow(fromButton)).toEqual([{ nodeId: "n_d", message: "{{go.x}}: “go” is a button, it has no values" }]);
});

test("validateDataSteps reports a deleted field and an attachment field", () => {
  const def = chatThenData();
  const withPhoto = withStep(def, {
    ...dataStep(def),
    action: "create-row",
    inputs: [
      { fieldId: "f_gone", source: { type: "value", value: "x" } },
      { fieldId: "f_photo", source: { type: "value", value: "" } },
      { fieldId: "f_name", source: { type: "value", value: "a" } },
      { fieldId: "f_name", source: { type: "value", value: "b" } },
    ],
  } as DataStep);
  expect(validateDataSteps(withPhoto, [projects])).toEqual([
    { nodeId: "n_data", message: "A field this step sets no longer exists in Projects" },
    { nodeId: "n_data", message: "“Photo” holds files, which a workflow can't set" },
    { nodeId: "n_data", message: "“Name” is set twice" },
  ]);
  expect(validateDataSteps(def, [])).toEqual([{ nodeId: "n_data", message: "This step's table no longer exists" }]);
  expect(validateDataSteps(withStep(def, { ...dataStep(def), tableId: "" }), [])).toEqual([{ nodeId: "n_data", message: "Choose a table" }]);
  expect(validateDataSteps(def, [projects])).toEqual([]);
});

test("validateDataSteps refuses a literal that doesn't fit its field and an op its type doesn't have", () => {
  const def = chatThenData();
  const literal = setSource(def, "n_data", { fieldId: "f_price" }, { type: "value", value: "lots" });
  expect(validateDataSteps(literal, [projects])).toEqual([{ nodeId: "n_data", message: "“Price”: expected a number, got “lots”" }]);
  const find = withStep(def, {
    id: "n_data",
    key: "create_project",
    type: "data",
    name: "Find",
    action: "find-rows",
    tableId: "t_projects",
    filters: [
      { fieldId: "f_price", op: "contains", value: { type: "value", value: "1" } },
      { fieldId: "f_price", op: ">", value: { type: "value", value: "" } },
      { fieldId: "f_price", op: ">" },
      { fieldId: "f_status", op: "is", value: { type: "value", value: "Someday" } },
      { fieldId: "f_name", op: "contains", value: { type: "value", value: "%" } },
      { fieldId: "f_price", op: "empty" },
      { fieldId: "f_price", op: ">=", value: { type: "output", nodeId: "n_chat", name: "budget" } },
    ],
    limit: 20,
  });
  expect(validateDataSteps(find, [projects])).toEqual([
    { nodeId: "n_data", message: "“Price” can't be filtered by “contains”" },
    { nodeId: "n_data", message: "“Price”: a value is needed" },
    { nodeId: "n_data", message: "“Price”: a value is needed" },
    { nodeId: "n_data", message: "“Status”: expected one of the field's choices, got “Someday”" },
  ]);
  const update = withStep(def, { ...dataStep(def), action: "update-row", rowId: { type: "value", value: " " } } as DataStep);
  expect(validateDataSteps(update, [projects])).toEqual([{ nodeId: "n_data", message: "Choose the row to update" }]);
});

test("renaming the source node keeps the wiring", () => {
  const def = chatThenData();
  const renamed = renameNode(def, "n_chat", "Project brief");
  expect(deriveExpectedOutputs(renamed, [projects])).toEqual(deriveExpectedOutputs(def, [projects]));
  expect(validateWorkflow(renameNode(def, "n_data", "Save it"))).toEqual([]);
});

test("a data step parses, with a find-rows limit of 20 by default and at most 100", () => {
  const find = { id: "n_f", key: "f", type: "data", name: "F", action: "find-rows", tableId: "t", filters: [] };
  const def = { ...chatThenData(), steps: [find] };
  expect(WorkflowDef.parse(def).steps[0]).toEqual({ ...find, limit: 20 });
  expect(WorkflowDef.safeParse({ ...def, steps: [{ ...find, limit: 101 }] }).success).toBe(false);
  expect(WorkflowDef.safeParse({ ...def, steps: [{ ...find, action: "delete-row" }] }).success).toBe(false);
  const bad = { ...dataStep(chatThenData()), inputs: [{ fieldId: "f_name", source: { type: "output", nodeId: "n_chat", name: "constructor" } }] };
  expect(WorkflowDef.safeParse({ ...def, steps: [bad] }).success).toBe(false);
});

test("a workflow saved by an earlier version still parses", () => {
  const slice1 = {
    trigger: {
      type: "manual",
      field: { id: "n_chat", key: "brief", type: "chat", label: "Brief", agentId: "agent_1", prompt: "Ask what to build." },
    },
    steps: [{ id: "n_plan", key: "plan", type: "agent", name: "Plan", agentId: "agent_1", prompt: "Plan {{brief.idea}} for {{brief.audience}}." }],
    edges: [{ from: "n_chat", to: "n_plan" }],
  };
  expect(WorkflowDef.parse(slice1)).toEqual(slice1);
});
