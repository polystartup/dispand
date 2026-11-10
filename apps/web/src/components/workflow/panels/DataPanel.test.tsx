// @vitest-environment jsdom
import type { TableSchema } from "@dispand/domain/workflows/data-steps";
import { deriveExpectedOutputs } from "@dispand/domain/workflows/derive";
import { addStep, defaultWorkflowDef, type DataStep, type WorkflowDef } from "@dispand/domain/workflows/model";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { DataPanel } from "./DataPanel.tsx";

afterEach(cleanup);

const projects: TableSchema = {
  id: "tbl_projects",
  name: "Projects",
  fields: [
    { id: "f_name", name: "Name", type: "text", choices: [] },
    { id: "f_short", name: "Short description", type: "long-text", choices: [] },
    { id: "f_logo", name: "Logo", type: "attachment", choices: [] },
  ],
};

/** Chat "Brief" → agent "Architecture" → Data "Save", the data step on Projects already. */
function workflow(inLoop = false): WorkflowDef {
  let def = defaultWorkflowDef("n_chat");
  def = { ...def, trigger: { type: "manual", field: { id: "n_chat", key: "brief", type: "chat", label: "Brief", agentId: "", prompt: "" } } };
  def = addStep(def, { after: "n_chat" }, "n_arch", "agent");
  def = addStep(def, { after: "n_arch" }, "n_data", "data");
  return {
    ...def,
    steps: def.steps.map((s) => {
      if (s.id === "n_arch" && s.type === "agent") return { ...s, name: "Architecture", key: "architecture" };
      if (s.id === "n_data" && s.type === "data") return { ...s, tableId: projects.id, ...(inLoop ? { loopId: "n_loop" } : {}) };
      return s;
    }),
  };
}

function dataStep(def: WorkflowDef): DataStep {
  return def.steps.find((s): s is DataStep => s.type === "data")!;
}

/** The panel over a workflow it edits, like the editor; `onChange` sees every edit. */
function setup(onChange = vi.fn(), inLoop = false) {
  function Harness() {
    const [def, setDef] = useState(() => workflow(inLoop));
    return (
      <DataPanel
        def={def}
        step={dataStep(def)}
        tables={[projects]}
        tableList={[{ id: projects.id, name: projects.name }]}
        expected={deriveExpectedOutputs(def, [projects])}
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

test("ticking a field wires it to the nearest agent step", async () => {
  const { onChange, user } = setup();
  await user.click(screen.getByRole("checkbox", { name: "Short description" }));
  const step = dataStep(onChange.mock.lastCall![0] as WorkflowDef);
  expect(step.action === "create-row" && step.inputs).toEqual([
    { fieldId: "f_short", source: { type: "output", nodeId: "n_arch", name: "short_description" } },
  ]);
});

test("choosing another step in the source picker rewires the input", async () => {
  const { onChange, user } = setup();
  await user.click(screen.getByRole("checkbox", { name: "Name" }));
  const input = screen.getByRole("group", { name: "Name" });
  await user.selectOptions(within(input).getByLabelText("From"), "Brief");
  const def = onChange.mock.lastCall![0] as WorkflowDef;
  const step = dataStep(def);
  // The name the agent is asked for goes with it.
  expect(step.action === "create-row" && step.inputs).toEqual([{ fieldId: "f_name", source: { type: "output", nodeId: "n_chat", name: "name" } }]);
  expect(deriveExpectedOutputs(def, [projects])["n_chat"]!.map((o) => o.name)).toEqual(["name"]);
  expect(deriveExpectedOutputs(def, [projects])["n_arch"]).toEqual([]);
  // A value instead: typed by the field.
  await user.selectOptions(within(input).getByLabelText("From"), "A value");
  await user.type(within(input).getByLabelText("Value"), "Dispand");
  const typed = dataStep(onChange.mock.lastCall![0] as WorkflowDef);
  expect(typed.action === "create-row" && typed.inputs[0]!.source).toEqual({ type: "value", value: "Dispand" });
});

test("attachment fields can't be ticked", () => {
  setup();
  const logo = screen.getByRole("checkbox", { name: "Logo" });
  expect((logo as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText("Files can't be set by a workflow yet")).toBeTruthy();
});

test("switching the action keeps the table and gives that action's values", async () => {
  const { onChange, user } = setup();
  await user.selectOptions(screen.getByLabelText("Action"), "Find rows");
  const step = dataStep(onChange.mock.lastCall![0] as WorkflowDef);
  expect(step).toMatchObject({ action: "find-rows", tableId: projects.id, filters: [], limit: 20 });
  expect(screen.getByText("{{data_2.rows}}")).toBeTruthy();
});

test("resetting the action or the table keeps the step in its loop", async () => {
  const { onChange, user } = setup(vi.fn(), true);
  await user.selectOptions(screen.getByLabelText("Action"), "Find rows");
  expect(dataStep(onChange.mock.lastCall![0] as WorkflowDef)).toMatchObject({ action: "find-rows", loopId: "n_loop" });
  await user.selectOptions(screen.getByLabelText("Table"), "Projects");
  expect(dataStep(onChange.mock.lastCall![0] as WorkflowDef)).toMatchObject({ tableId: projects.id, loopId: "n_loop" });
});
