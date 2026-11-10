import { expect, test } from "vitest";
import { effectiveTools } from "./tools.ts";

test("explicit tools, then the ones skills require, locked by every skill that requires them", () => {
  expect(
    effectiveTools(["tool_a", "tool_b"], [
      { name: "review", requiredToolIds: ["tool_b", "tool_c"] },
      { name: "deploy", requiredToolIds: ["tool_c"] },
    ]),
  ).toEqual([
    { toolId: "tool_a", explicit: true, lockedBy: [] },
    { toolId: "tool_b", explicit: true, lockedBy: ["review"] },
    { toolId: "tool_c", explicit: false, lockedBy: ["review", "deploy"] },
  ]);
});

test("no skills, only the explicit tools; no tools at all, none", () => {
  expect(effectiveTools(["tool_a"], [])).toEqual([{ toolId: "tool_a", explicit: true, lockedBy: [] }]);
  expect(effectiveTools([], [{ name: "notes", requiredToolIds: [] }])).toEqual([]);
});

test("a package listing a tool twice locks it once", () => {
  expect(effectiveTools([], [{ name: "review", requiredToolIds: ["tool_a", "tool_a"] }])).toEqual([{ toolId: "tool_a", explicit: false, lockedBy: ["review"] }]);
});
