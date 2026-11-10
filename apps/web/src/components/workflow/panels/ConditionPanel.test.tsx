// @vitest-environment jsdom
import { deriveExpectedOutputs } from "@dispand/domain/workflows/derive";
import { addStep, defaultWorkflowDef, type ConditionStep, type WorkflowDef } from "@dispand/domain/workflows/model";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { ConditionPanel } from "./ConditionPanel.tsx";

afterEach(cleanup);

/** Chat "Brief" → If → Later, with "Later" asking the chat for `idea`. */
function workflow(): WorkflowDef {
  let def = defaultWorkflowDef("n_brief");
  def = { ...def, trigger: { type: "manual", field: { id: "n_brief", key: "brief", type: "chat", label: "Brief", agentId: "", prompt: "" } } };
  def = addStep(def, { after: "n_brief" }, "n_if", "condition");
  def = addStep(def, { after: "n_if", branch: "then" }, "n_later", "agent");
  return { ...def, steps: def.steps.map((s) => (s.id === "n_later" && s.type === "agent" ? { ...s, name: "Later", key: "later", prompt: "{{brief.idea}} {{if.matched}}" } : s)) };
}

function condition(def: WorkflowDef): ConditionStep {
  return def.steps.find((s): s is ConditionStep => s.type === "condition")!;
}

/** The panel over a workflow it edits, like the editor; `onChange` sees every edit. */
function setup(onChange = vi.fn()) {
  function Harness() {
    const [def, setDef] = useState(workflow);
    return (
      <ConditionPanel
        def={def}
        step={condition(def)}
        expected={deriveExpectedOutputs(def)}
        onChange={(next) => {
          onChange(next);
          setDef(next);
        }}
      />
    );
  }
  render(<Harness />);
  return { onChange, user: userEvent.setup() };
}

test("changing the operator calls onChange with op", async () => {
  const { onChange, user } = setup();
  await user.selectOptions(screen.getByLabelText("Operator"), "is greater than");
  expect(condition(onChange.mock.lastCall![0] as WorkflowDef).op).toBe("greater_than");
});

test("picking \"is empty\" hides the operand", async () => {
  const { user } = setup();
  expect(screen.getByLabelText("Compare with")).toBeTruthy();
  await user.selectOptions(screen.getByLabelText("Operator"), "is empty");
  expect(screen.queryByLabelText("Compare with")).toBeNull();
});

test("the operand is saved as typed", async () => {
  const { onChange, user } = setup();
  await user.type(screen.getByLabelText("Compare with"), "yes");
  expect(condition(onChange.mock.lastCall![0] as WorkflowDef).operand).toBe("yes");
});

test("the value comes from an upstream step only, and a chat's value can be a new one", async () => {
  const { onChange, user } = setup();
  const from = screen.getByLabelText("From");
  // Upstream only: the step after the condition isn't offered.
  expect([...(from as HTMLSelectElement).options].map((o) => o.text)).toEqual(["Choose a step", "Brief"]);
  await user.selectOptions(from, "Brief");
  // The chat already gives `idea` (a later prompt asks for it): picked first.
  expect(condition(onChange.mock.lastCall![0] as WorkflowDef).value).toEqual({ type: "output", nodeId: "n_brief", name: "idea" });
  const value = screen.getByLabelText("Value");
  await user.clear(value);
  await user.type(value, "approved");
  expect(condition(onChange.mock.lastCall![0] as WorkflowDef).value).toEqual({ type: "output", nodeId: "n_brief", name: "approved" });
  // A name that can't be a value isn't saved: the condition has no value until it can.
  await user.clear(value);
  await user.type(value, "2x");
  expect(condition(onChange.mock.lastCall![0] as WorkflowDef).value).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("letters, digits and _");
});
