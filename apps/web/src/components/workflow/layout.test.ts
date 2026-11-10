import { addStep, connect, defaultWorkflowDef, type WorkflowDef } from "@dispand/domain/workflows/model";
import { expect, test } from "vitest";
import { CARD, layoutWorkflow } from "./layout.ts";

/** Start → A, B → C. */
function diamond(): WorkflowDef {
  let def = defaultWorkflowDef("n_start");
  def = addStep(def, { after: "n_start" }, "n_a", "agent");
  def = addStep(def, { after: "n_start" }, "n_b", "agent");
  def = addStep(def, { after: "n_a" }, "n_c", "agent");
  const joined = connect(def, "n_b", "n_c");
  if (!("def" in joined)) throw new Error(joined.refused);
  return joined.def;
}

test("layout puts every node below all its predecessors", () => {
  const { nodes } = layoutWorkflow(diamond());
  expect(nodes.n_c!.y).toBeGreaterThan(nodes.n_a!.y);
  expect(nodes.n_c!.y).toBeGreaterThan(nodes.n_b!.y);
  expect(nodes.n_a!.y).toBe(nodes.n_b!.y);
  expect(nodes.n_a!.y).toBeGreaterThan(nodes.n_start!.y);
});

test("layout gives no two cards overlapping boxes", () => {
  let def = diamond();
  for (const id of ["n_d", "n_e", "n_f"]) def = addStep(def, { after: "n_start" }, id, "agent");
  const boxes = Object.values(layoutWorkflow(def).nodes);
  expect(boxes).toHaveLength(7);
  for (const [i, a] of boxes.entries()) {
    for (const b of boxes.slice(i + 1)) {
      const apart = a.x + CARD.w <= b.x || b.x + CARD.w <= a.x || a.y + CARD.h <= b.y || b.y + CARD.h <= a.y;
      expect(apart).toBe(true);
    }
  }
});

test("a condition's Then branch is laid out left of its Else branch, whatever order they were added in", () => {
  for (const first of ["then", "else"] as const) {
    let def = addStep(defaultWorkflowDef("n_start"), { after: "n_start" }, "n_x", "agent");
    def = addStep(def, { after: "n_start" }, "n_if", "condition");
    for (const branch of first === "then" ? (["then", "else"] as const) : (["else", "then"] as const)) {
      def = addStep(def, { after: "n_if", branch }, `n_${branch}`, "agent");
      def = addStep(def, { after: `n_${branch}` }, `n_${branch}_2`, "agent");
    }
    const { nodes } = layoutWorkflow(def);
    expect(nodes.n_then!.x).toBeLessThan(nodes.n_else!.x);
    expect(nodes.n_then_2!.x).toBeLessThan(nodes.n_else_2!.x);
  }
});

/** Start → For each (A → B) → After, and a second, empty loop beside it. */
function looped(): WorkflowDef {
  let def = defaultWorkflowDef("n_start");
  def = addStep(def, { after: "n_start" }, "n_loop", "loop");
  def = addStep(def, { loop: "n_loop" }, "n_a", "agent");
  def = addStep(def, { after: "n_a" }, "n_b", "agent");
  def = addStep(def, { after: "n_loop" }, "n_after", "agent");
  return addStep(def, { after: "n_start" }, "n_empty", "loop");
}

test("layout puts every body node inside its loop's group box", () => {
  const { nodes, groups } = layoutWorkflow(looped());
  const group = groups.n_loop!;
  for (const id of ["n_a", "n_b"]) {
    const card = nodes[id]!;
    expect(card.x).toBeGreaterThanOrEqual(group.x);
    expect(card.y).toBeGreaterThanOrEqual(group.y);
    expect(card.x + CARD.w).toBeLessThanOrEqual(group.x + group.w);
    expect(card.y + CARD.h).toBeLessThanOrEqual(group.y + group.h);
  }
  expect(nodes.n_b!.y).toBeGreaterThan(nodes.n_a!.y);
  // The loop is one node: the group's box is where it is, and what follows it is below it.
  expect(nodes.n_loop).toEqual({ x: group.x, y: group.y });
  expect(nodes.n_after!.y).toBeGreaterThanOrEqual(group.y + group.h);
  expect(nodes.n_loop!.y).toBeGreaterThan(nodes.n_start!.y);
});

test("an empty loop still gets a box, and no box overlaps another", () => {
  const { nodes, groups } = layoutWorkflow(looped());
  const empty = groups.n_empty!;
  expect(empty.h).toBeGreaterThan(CARD.h);
  const group = groups.n_loop!;
  const apart = empty.x + empty.w <= group.x || group.x + group.w <= empty.x || empty.y + empty.h <= group.y || group.y + group.h <= empty.y;
  expect(apart).toBe(true);
  expect(Object.keys(nodes).sort()).toEqual(["n_a", "n_after", "n_b", "n_empty", "n_loop", "n_start"]);
});
