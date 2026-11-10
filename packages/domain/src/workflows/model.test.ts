import { expect, test } from "vitest";
import { structuralIssues } from "./derive.ts";
import { addStep, connect, defaultWorkflowDef, disconnect, removeStep, WorkflowDef } from "./model.ts";

/** Start button → A, plus an unlinked B. */
function twoSteps(): WorkflowDef {
  const def = addStep(defaultWorkflowDef("n_start"), { after: "n_start" }, "n_a", "agent");
  return { ...def, steps: [...def.steps, { id: "n_b", key: "b", type: "agent", name: "B", agentId: "", prompt: "" }] };
}

test("addStep after a node with a successor makes a parallel branch", () => {
  const def = addStep(twoSteps(), { after: "n_start" }, "n_new", "agent");
  expect(def.steps.at(-1)).toEqual({ id: "n_new", key: "step_3", type: "agent", name: "Step 3", agentId: "", prompt: "" });
  expect(def.edges).toEqual([
    { from: "n_start", to: "n_a" },
    { from: "n_start", to: "n_new" },
  ]);
});

test("addStep on an edge inserts between", () => {
  const def = addStep(twoSteps(), { edge: { from: "n_start", to: "n_a" } }, "n_new", "agent");
  expect(def.edges).toEqual([
    { from: "n_start", to: "n_new" },
    { from: "n_new", to: "n_a" },
  ]);
});

test("addStep refuses a branch after a step that is not a condition, and a body of a step that is not a loop", () => {
  expect(() => addStep(twoSteps(), { after: "n_start", branch: "then" }, "n_new", "agent")).toThrow("Only a condition has Then and Else");
  expect(() => addStep(twoSteps(), { loop: "n_a" }, "n_new", "agent")).toThrow("This step's loop doesn't exist");
});

test("connect makes a join", () => {
  let def = addStep(twoSteps(), { after: "n_a" }, "n_c", "agent");
  def = { ...def, edges: [...def.edges, { from: "n_start", to: "n_b" }] };
  const joined = connect(def, "n_b", "n_c");
  expect(joined).toEqual({ def: { ...def, edges: [...def.edges, { from: "n_b", to: "n_c" }] } });
});

test("connect refuses a loop", () => {
  const def = addStep(twoSteps(), { after: "n_a" }, "n_c", "agent");
  expect(connect(def, "n_c", "n_a")).toEqual({ refused: "This link would make a loop" });
});

test("connect refuses an edge into the trigger", () => {
  expect(connect(twoSteps(), "n_b", "n_start")).toEqual({ refused: "Nothing runs before the trigger" });
});

test("connect refuses a step following itself, an existing link and a branch", () => {
  const def = twoSteps();
  expect(connect(def, "n_a", "n_a")).toEqual({ refused: "A step can't follow itself" });
  expect(connect(def, "n_start", "n_a")).toEqual({ refused: "These steps are already linked" });
  expect(connect(def, "n_a", "n_b", "else")).toEqual({ refused: "Only a condition has Then and Else" });
});

test("disconnect keeps the nodes", () => {
  const def = disconnect(twoSteps(), { from: "n_start", to: "n_a" });
  expect(def.edges).toEqual([]);
  expect(def.steps.map((s) => s.id)).toEqual(["n_a", "n_b"]);
});

/** Start button → If, plus an unlinked B. */
function withCondition(): WorkflowDef {
  return addStep(twoSteps(), { after: "n_start" }, "n_if", "condition");
}

test("addStep adds a condition with its defaults", () => {
  expect(withCondition().steps.at(-1)).toEqual({ id: "n_if", key: "if", type: "condition", name: "If", value: null, op: "equals", operand: "" });
});

test("addStep after a condition takes a branch, and needs one", () => {
  const def = addStep(withCondition(), { after: "n_if", branch: "then" }, "n_t", "agent");
  expect(def.edges.at(-1)).toEqual({ from: "n_if", to: "n_t", branch: "then" });
  expect(() => addStep(withCondition(), { after: "n_if" }, "n_t", "agent")).toThrow("Choose Then or Else for this link");
  // Inserting on a branch keeps the branch on the edge out of the condition.
  const inserted = addStep(def, { edge: { from: "n_if", to: "n_t" } }, "n_x", "agent");
  expect(inserted.edges.slice(-2)).toEqual([
    { from: "n_if", to: "n_x", branch: "then" },
    { from: "n_x", to: "n_t" },
  ]);
});

test("a condition inserted on a link leads on through Then, so the workflow stays saveable", () => {
  const def = addStep(twoSteps(), { edge: { from: "n_start", to: "n_a" } }, "n_if", "condition");
  expect(def.edges).toEqual([
    { from: "n_start", to: "n_if" },
    { from: "n_if", to: "n_a", branch: "then" },
  ]);
  expect(structuralIssues(def)).toEqual([]);
  // A second condition is "If 2".
  expect(addStep(def, { after: "n_a" }, "n_if2", "condition").steps.at(-1)).toMatchObject({ name: "If 2", key: "if_2" });
});

test("connect from a condition needs a branch", () => {
  const def = withCondition();
  expect(connect(def, "n_if", "n_b")).toEqual({ refused: "Choose Then or Else for this link" });
  expect(connect(def, "n_if", "n_b", "else")).toEqual({ def: { ...def, edges: [...def.edges, { from: "n_if", to: "n_b", branch: "else" }] } });
});

test("removing a step keeps the branch it was on", () => {
  let def = addStep(withCondition(), { after: "n_if", branch: "else" }, "n_e", "agent");
  def = addStep(def, { after: "n_e" }, "n_after", "agent");
  expect(removeStep(def, "n_e").edges.at(-1)).toEqual({ from: "n_if", to: "n_after", branch: "else" });
});

test("old definitions still parse", () => {
  const old = {
    trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } },
    steps: [{ id: "n_a", key: "a", type: "agent", name: "A", agentId: "agent_1", prompt: "Do it." }],
    edges: [{ from: "n_go", to: "n_a" }],
  };
  expect(WorkflowDef.parse(old)).toEqual(old);
});

/** Start button → loop "For each" (body: entry E → F) → after A. */
function withLoop(): WorkflowDef {
  let def = addStep(defaultWorkflowDef("n_start"), { after: "n_start" }, "n_each", "loop");
  def = addStep(def, { loop: "n_each" }, "n_e", "agent");
  def = addStep(def, { after: "n_e" }, "n_f", "agent");
  return addStep(def, { after: "n_each" }, "n_a", "agent");
}

test("addStep adds a loop with its defaults, and its body steps inside it", () => {
  const def = withLoop();
  expect(def.steps).toEqual([
    { id: "n_each", key: "for_each", type: "loop", name: "For each", list: null, maxIterations: 20 },
    { id: "n_e", key: "step_2", type: "agent", name: "Step 2", agentId: "", prompt: "", loopId: "n_each" },
    { id: "n_f", key: "step_3", type: "agent", name: "Step 3", agentId: "", prompt: "", loopId: "n_each" },
    { id: "n_a", key: "step_4", type: "agent", name: "Step 4", agentId: "", prompt: "" },
  ]);
  // The body's entry step has no link: it starts when its iteration does.
  expect(def.edges).toEqual([
    { from: "n_start", to: "n_each" },
    { from: "n_e", to: "n_f" },
    { from: "n_each", to: "n_a" },
  ]);
  expect(addStep(def, { edge: { from: "n_e", to: "n_f" } }, "n_x", "agent").steps.at(-1)).toMatchObject({ loopId: "n_each" });
  expect(addStep(def, { after: "n_a" }, "n_each2", "loop").steps.at(-1)).toMatchObject({ name: "For each 2", key: "for_each_2" });
  expect(structuralIssues(def)).toEqual([]);
});

test("a nested loop is refused", () => {
  expect(() => addStep(withLoop(), { loop: "n_each" }, "n_in", "loop")).toThrow("Loops can't be nested yet");
  expect(() => addStep(withLoop(), { after: "n_e" }, "n_in", "loop")).toThrow("Loops can't be nested yet");
});

test("an edge from the body to outside is refused", () => {
  const def = withLoop();
  expect(connect(def, "n_f", "n_a")).toEqual({ refused: "A link can't cross the edge of a loop" });
  expect(connect(def, "n_each", "n_e")).toEqual({ refused: "A link can't cross the edge of a loop" });
  expect(connect(def, "n_start", "n_f")).toEqual({ refused: "A link can't cross the edge of a loop" });
});

test("removing a loop removes its body", () => {
  const def = removeStep(withLoop(), "n_each");
  expect(def.steps.map((s) => s.id)).toEqual(["n_a"]);
  expect(def.edges).toEqual([{ from: "n_start", to: "n_a" }]);
});
