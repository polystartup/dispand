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
  expect(skillCommands(skills)).toEqual([{ name: "office:tidy", description: "Office", nativeNamespace: "office" }, { name: "other:tidy", description: "Other", nativeNamespace: "other" }]);
  expect(skillInputs("/other:tidy rows", skills)[0]).toMatchObject({ type: "skill", path: skills[1]!.path });
});

test("user and repository skills sharing an .agents parent retain distinct identities", async () => {
  const { skillCommands } = await import("./skills.ts");
  const skills = [{ ...skill, path: "/user/.agents/skills/tidy/SKILL.md", scope: "user" }, { ...skill, path: "/project/.agents/skills/tidy/SKILL.md", scope: "repo" }];
  expect(skillCommands(skills).map((s) => s.name)).toEqual(["user:tidy", "repo:tidy"]);
  expect(skillInputs("/repo:tidy rows", skills)[0]).toMatchObject({ type: "skill", path: skills[1]!.path });
});

test("same-scope collisions have stable distinct invocations without exposing local paths", async () => {
  const { skillCommands } = await import("./skills.ts");
  const skills = [{ ...skill, path: "/one/.agents/skills/tidy/SKILL.md", scope: "user" }, { ...skill, path: "/two/.agents/skills/tidy/SKILL.md", scope: "user" }];
  const commands = skillCommands(skills);
  expect(commands[0]!.name).not.toBe(commands[1]!.name);
  for (const [i, command] of commands.entries()) {
    expect(command.name).not.toContain("/");
    expect(skillInputs(`/${command.name}`, skills)[0]).toMatchObject({ type: "skill", path: skills[i]!.path });
  }
});

test("an exact user-scope identity wins over a plugin's shorthand alias", async () => {
  const { skillCommands } = await import("./skills.ts");
  const skills = [{ ...skill, pluginId: "user@catalog", path: "/plugins/user/skills/tidy/SKILL.md" }, { ...skill, path: "/user/.agents/skills/tidy/SKILL.md", scope: "user" }];
  expect(skillCommands(skills).map((s) => s.name)).toEqual(["user@catalog:tidy", "user:tidy"]);
  expect(skillInputs("/user:tidy", skills)[0]).toMatchObject({ type: "skill", path: skills[1]!.path });
});
