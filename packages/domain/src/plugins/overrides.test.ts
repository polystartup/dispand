import { getTableColumns } from "drizzle-orm";
import { expect, test } from "vitest";
import { agents, tools, triggers } from "../db/schema.ts";
import { ELEMENT_FIELDS, overriddenAfter, qualifiedName, rebase, sameValue } from "./overrides.ts";

test("every column of an element's table is the plugin's, a local setting or the system's", () => {
  // A column added later must be classed: an unclassed one would be written with no override recorded.
  for (const [kind, table] of [["agent", agents], ["tool", tools], ["trigger", triggers]] as const) {
    const { overridable, local, system } = ELEMENT_FIELDS[kind];
    const known = new Set<string>([...overridable, ...local, ...system]);
    expect(Object.keys(getTableColumns(table)).filter((column) => !known.has(column))).toEqual([]);
  }
});

test("id lists compare as sets, consults by agent, everything else by value", () => {
  expect(sameValue("agent", "toolIds", ["a", "b"], ["b", "a"])).toBe(true);
  expect(sameValue("agent", "toolIds", ["a"], ["a", "b"])).toBe(false);
  expect(sameValue("agent", "dataTables", "all", ["t"])).toBe(false);
  expect(sameValue("agent", "consults", [{ agentId: "a", ask: false }, { agentId: "b", ask: true }], [{ ask: true, agentId: "b" }, { agentId: "a", ask: false }])).toBe(true);
  expect(sameValue("agent", "bundles", ["data", "configure"], ["configure", "data"])).toBe(true);
  expect(sameValue("agent", "systemPrompt", "a", "a ")).toBe(false);
});

const element = { upstream: { name: "Drafting", systemPrompt: "Draft.", toolIds: ["t1"] }, overridden: ["systemPrompt"] };

test("a write lists the fields that differ from the plugin's, and a field written back leaves the list", () => {
  expect(overriddenAfter("agent", element, { name: "Drafts", systemPrompt: "Mine." })).toEqual(["systemPrompt", "name"]);
  expect(overriddenAfter("agent", element, { systemPrompt: "Draft." })).toEqual([]);
  // A field the write leaves out stays as it was; a local setting is never listed.
  expect(overriddenAfter("agent", element, { harnessId: "h2", toolIds: ["t1"] })).toEqual(["systemPrompt"]);
  // Not a plugin's element: nothing is an override.
  expect(overriddenAfter("agent", { upstream: null, overridden: [] }, { name: "x" })).toEqual([]);
});

test("a rebase writes the fields the owner left alone and reports the overridden ones the plugin changed", () => {
  const current = { name: "Drafting", systemPrompt: "Mine.", toolIds: ["t1"] };
  const out = rebase("agent", element, current, { name: "Drafter", systemPrompt: "Draft well.", toolIds: ["t1"] });
  expect(out.set).toEqual({ name: "Drafter" });
  expect(out.conflicts).toEqual([{ field: "systemPrompt", old: "Draft.", mine: "Mine.", next: "Draft well." }]);
  expect(out.upstream).toEqual({ name: "Drafter", systemPrompt: "Draft well.", toolIds: ["t1"] });
  // An overridden field the plugin didn't change is no conflict.
  expect(rebase("agent", element, current, { ...element.upstream, name: "Drafter" }).conflicts).toEqual([]);
});

test("a plugin's element reads under its plugin's name", () => {
  expect(qualifiedName("law-firm", "Drafting")).toBe("law-firm/Drafting");
  expect(qualifiedName(null, "Drafting")).toBe("Drafting");
});
