import { expect, test } from "vitest";
import { skillInputs } from "./skills.ts";
const skill = { name: "tidy", description: "Tidy", path: "/plugins/office/skills/tidy/SKILL.md", enabled: true, scope: "user", pluginId: null } as const;
test("a slash skill becomes a native Codex skill input and keeps its arguments", () => {
  expect(skillInputs("/office:tidy these rows", [skill])).toEqual([{ type: "skill", name: "tidy", path: skill.path }, { type: "text", text: "these rows", text_elements: [] }]);
});
test("unknown, disabled or ambiguous skills stay ordinary text", () => {
  for (const skills of [[], [{ ...skill, enabled: false }], [skill, { ...skill, path: "/other/SKILL.md" }]]) {
    expect(skillInputs("/tidy rows", skills)).toEqual([{ type: "text", text: "/tidy rows", text_elements: [] }]);
  }
});

test("plugin catalogs preserve namespaces so skills sharing a leaf name remain invokable", async () => {
  const { skillCommands } = await import("./skills.ts");
  const skills = [{ ...skill, pluginId: "office", description: "Office" }, { ...skill, pluginId: "other", description: "Other", path: "/plugins/other/skills/tidy/SKILL.md" }];
  expect(skillCommands(skills)).toEqual([{ name: "office:tidy", description: "Office" }, { name: "other:tidy", description: "Other" }]);
  expect(skillInputs("/other:tidy rows", skills)[0]).toMatchObject({ type: "skill", path: skills[1]!.path });
});
