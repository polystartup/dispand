import { ASSISTANT_NAME } from "@dispand/domain/assistant-name";
import { expect, onTestFinished, test } from "vitest";
import { acceptedLanguages, createI18n, detectLanguage, pageLanguage, resources } from "./i18n.ts";

test("the first of English or French in the browser's order wins, else English", () => {
  expect(detectLanguage(["fr-CA", "en"])).toBe("fr");
  expect(detectLanguage(["de", "en-GB"])).toBe("en");
  expect(detectLanguage(["de"])).toBe("en");
  expect(detectLanguage([])).toBe("en");
});

test("Accept-Language is ordered by quality, and q=0 is dropped", () => {
  expect(acceptedLanguages("fr-CA,fr;q=0.9")).toEqual(["fr-CA", "fr"]);
  expect(acceptedLanguages("en;q=0.5, fr;q=1")).toEqual(["fr", "en"]);
  expect(acceptedLanguages("fr;q=0, en")).toEqual(["en"]);
  expect(acceptedLanguages(null)).toEqual([]);
  expect(detectLanguage(acceptedLanguages("en;q=0.5, fr;q=1"))).toBe("fr");
  expect(detectLanguage(acceptedLanguages("fr;q=0, en"))).toBe("en");
});

test("a saved language wins over the browser's", () => {
  expect(pageLanguage("fr", "en")).toBe("fr");
  expect(pageLanguage("en", "fr-FR,fr")).toBe("en");
  expect(pageLanguage(null, "fr-FR,fr")).toBe("fr");
  expect(pageLanguage(undefined, null)).toBe("en");
});

test("a key missing in French renders the English text", () => {
  const i18n = createI18n("fr");
  // The bundled resources are shared by every instance: take the key back out.
  onTestFinished(() => void delete (resources.en.common as Record<string, unknown>).onlyInEnglish);
  i18n.addResource("en", "common", "onlyInEnglish", "Only in English");
  expect(i18n.t("onlyInEnglish" as never)).toBe("Only in English");
  expect(i18n.t("actions.cancel")).toBe("Annuler");
});

test("each request gets its own instance: changing one language leaves the others", () => {
  const fr = createI18n("fr");
  const en = createI18n("en");
  expect(fr.t("actions.cancel")).toBe("Annuler");
  expect(en.t("actions.cancel")).toBe("Cancel");
});

/** Every key of a resource, plural forms included, as dotted paths. */
const keys = (value: unknown, prefix = ""): string[] =>
  typeof value === "object" && value ? Object.entries(value).flatMap(([k, v]) => keys(v, `${prefix}${k}.`)) : [prefix.slice(0, -1)];

test("French has every English key of each namespace, and nothing more", () => {
  expect(Object.keys(resources.fr).sort()).toEqual(Object.keys(resources.en).sort());
  for (const ns of Object.keys(resources.en) as (keyof typeof resources.en)[]) {
    expect(keys(resources.fr[ns]).sort(), ns).toEqual(keys(resources.en[ns]).sort());
  }
});

test("the built-in agent is named Stem in both languages, the name its prompts use", () => {
  expect(createI18n("en").t("agent.assistant.name")).toBe("Stem");
  expect(createI18n("fr").t("agent.assistant.name")).toBe("Stem");
  expect(resources.en.common.agent.assistant.name).toBe(ASSISTANT_NAME);
});
