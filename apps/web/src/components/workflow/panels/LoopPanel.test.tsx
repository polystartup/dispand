// @vitest-environment jsdom
import { deriveExpectedOutputs } from "@dispand/domain/workflows/derive";
import { addStep, defaultWorkflowDef, type LoopStep, type WorkflowDef } from "@dispand/domain/workflows/model";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { LoopPanel } from "./LoopPanel.tsx";

afterEach(cleanup);

/** Chat "Brief" → For each (Summarize). */
function workflow(): WorkflowDef {
  let def = defaultWorkflowDef("n_brief");
  def = { ...def, trigger: { type: "manual", field: { id: "n_brief", key: "brief", type: "chat", label: "Brief", agentId: "", prompt: "" } } };
  def = addStep(def, { after: "n_brief" }, "n_each", "loop");
  return addStep(def, { loop: "n_each" }, "n_sum", "agent");
}

function loop(def: WorkflowDef): LoopStep {
  return def.steps.find((s): s is LoopStep => s.type === "loop")!;
}

/** The panel over a workflow it edits, like the editor; `onChange` sees every edit. */
function setup(onChange = vi.fn()) {
  function Harness() {
    const [def, setDef] = useState(workflow);
    return (
      <LoopPanel
        def={def}
        step={loop(def)}
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

test("the list comes from an upstream step, asked for by name", async () => {
  const { onChange, user } = setup();
  const from = screen.getByLabelText("From") as HTMLSelectElement;
  // Upstream only: the loop's own body isn't offered.
  expect([...from.options].map((o) => o.text)).toEqual(["Choose a step", "Brief"]);
  await user.selectOptions(from, "Brief");
  await user.type(screen.getByLabelText("Value"), "items");
  expect(loop(onChange.mock.lastCall![0] as WorkflowDef).list).toEqual({ type: "output", nodeId: "n_brief", name: "items" });
});

test("At most takes 1 to 100 and keeps what can't be saved out of the workflow", async () => {
  const { onChange, user } = setup();
  const max = screen.getByLabelText("At most");
  expect(max).toHaveProperty("value", "20");
  await user.clear(max);
  await user.type(max, "5");
  expect(loop(onChange.mock.lastCall![0] as WorkflowDef).maxIterations).toBe(5);
  await user.clear(max);
  await user.type(max, "101");
  // The last valid number stays saved: 10 was valid, 101 isn't.
  expect(loop(onChange.mock.lastCall![0] as WorkflowDef).maxIterations).toBe(10);
  expect(screen.getByRole("alert").textContent).toContain("1 to 100");
  await user.clear(max);
  await user.type(max, "100");
  expect(loop(onChange.mock.lastCall![0] as WorkflowDef).maxIterations).toBe(100);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("the hint names the item and index of this loop", () => {
  setup();
  expect(screen.getByText("{{for_each.item}}")).toBeTruthy();
  expect(screen.getByText("{{for_each.index}}")).toBeTruthy();
});
