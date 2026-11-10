import { expect, test } from "vitest";
import { references, renderTemplate } from "./template.ts";

test("renderTemplate substitutes upstream values", () => {
  expect(renderTemplate("Build {{brief.idea}} for {{ brief.audience }}.", { brief: { idea: "a chat", audience: "teams" } })).toBe(
    "Build a chat for teams.",
  );
});

test("renderTemplate leaves unknown variables visible as {{key.field}}", () => {
  expect(renderTemplate("Use {{brief.idea}}, {{ plan.repo }} and {{brief.missing}}.", { brief: { idea: "x" } })).toBe(
    "Use x, {{plan.repo}} and {{brief.missing}}.",
  );
});

test("references lists every variable in order", () => {
  expect(references("{{a.x}} {{ b.y }} {{not a var}} {{a.x}}")).toEqual([
    { key: "a", field: "x" },
    { key: "b", field: "y" },
    { key: "a", field: "x" },
  ]);
});
