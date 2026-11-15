import { expect, test } from "vitest";
import { shownAgentName } from "./agent-name.ts";
import { createI18n, type Language } from "./i18n.ts";

const stem = { name: "Assistant", builtIn: "assistant", plugin: null };
const helper = { name: "helper", builtIn: null, plugin: { name: "legal" } };

test.each<Language>(["en", "fr"])("the built-in agent shows as Stem in %s, its stored name unchanged", (language) => {
  const t = createI18n(language).getFixedT(null, "messages");
  expect([stem, helper].map((a) => shownAgentName(t, a))).toEqual(["Stem", "legal/helper"]);
  expect(stem.name).toBe("Assistant");
});
