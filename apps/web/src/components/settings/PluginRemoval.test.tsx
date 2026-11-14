// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { removalPlan, RemovalChoices, type RemovalElement } from "./PluginRemoval.tsx";

afterEach(cleanup);

const el = (key: string, more: Partial<RemovalElement> = {}): RemovalElement => ({ key, kind: key.split(":")[0] as RemovalElement["kind"], id: key, name: key.split(":")[1]!, reasons: [], needs: [], keepOnly: null, ...more });
const elements = [
  el("agent:Drafting", { reasons: ["You changed it"], needs: ["agent:Intake"] }),
  el("agent:Intake", { needs: ["skill:research", "tool:case-law"] }),
  el("skill:research"),
  el("tool:case-law"),
  el("agent:Upkeep"),
  el("table:Matters", { reasons: ["It has 3 rows"] }),
  el("agent:Flow", { reasons: ["A workflow uses this agent"], keepOnly: "A workflow uses this agent" }),
];

test("what is asked about starts kept, with all a kept element needs; the rest goes with the plugin", () => {
  const plan = removalPlan(elements, {});
  expect(plan.asked.map((e) => e.key)).toEqual(["agent:Drafting", "table:Matters", "agent:Flow"]);
  expect(plan.needed.map((n) => [n.element.key, n.by])).toEqual([["agent:Intake", ["Drafting"]], ["skill:research", ["Intake"]], ["tool:case-law", ["Intake"]]]);
  expect(plan.gone).toBe(1);
  expect(plan.choices).toEqual({ "agent:Drafting": "keep", "table:Matters": "keep", "agent:Flow": "keep", "agent:Intake": "keep", "skill:research": "keep", "tool:case-law": "keep" });
});

test("deleting an element drops what only it needed from the list; a needed one may be deleted by a stated choice", () => {
  expect(removalPlan(elements, { "agent:Drafting": "delete" })).toMatchObject({ needed: [], gone: 4, choices: { "agent:Drafting": "delete", "table:Matters": "keep", "agent:Flow": "keep" } });
  const forced = removalPlan(elements, { "tool:case-law": "delete", "agent:Intake": "delete" });
  // Intake deleted: what it needed is no longer asked about.
  expect(forced.needed.map((n) => n.element.key)).toEqual(["agent:Intake"]);
  expect(forced.choices).toEqual({ "agent:Drafting": "keep", "table:Matters": "keep", "agent:Flow": "keep", "agent:Intake": "delete" });
});

test("each element shows why it is asked about and its two choices; one a workflow uses can only be kept", async () => {
  const change = vi.fn();
  render(<RemovalChoices plan={removalPlan(elements, {})} busy={false} onChange={change} />);
  const drafting = screen.getByRole("group", { name: "Drafting" });
  expect(drafting.textContent).toContain("You changed it");
  expect((within(drafting).getByRole("radio", { name: "Keep as yours" }) as HTMLInputElement).checked).toBe(true);
  await userEvent.click(within(drafting).getByRole("radio", { name: "Delete" }));
  expect(change).toHaveBeenCalledWith("agent:Drafting", "delete");
  expect(screen.getByRole("group", { name: "Intake" }).textContent).toContain("Needed by Drafting if you keep it");
  const flow = screen.getByRole("group", { name: "Flow" });
  expect(within(flow).queryByRole("radio", { name: "Delete" })).toBeNull();
  expect(flow.textContent).toContain("A workflow uses this agent");
  expect(screen.getByText("1 other element goes with the plugin.")).toBeTruthy();
});

test("a plugin nothing uses says so", () => {
  render(<RemovalChoices plan={removalPlan([el("agent:Upkeep"), el("tool:case-law")], {})} busy={false} onChange={() => {}} />);
  expect(screen.getByText("Nothing of it is in use: its 2 elements go with it.")).toBeTruthy();
});
