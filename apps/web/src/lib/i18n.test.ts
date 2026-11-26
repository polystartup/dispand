import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { I18nextProvider, useTranslation } from "react-i18next";
import { expect, onTestFinished, test } from "vitest";
import { acceptedLanguages, createI18n, detectLanguage, resolveLanguage, resources, withShellMessages } from "./i18n.ts";

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
  expect(resolveLanguage("fr", "en")).toBe("fr");
  expect(resolveLanguage("en", "fr-FR,fr")).toBe("en");
  expect(resolveLanguage(null, "fr-FR,fr")).toBe("fr");
  expect(resolveLanguage(undefined, null)).toBe("en");
});

test("a key missing in French renders the English text", () => {
  const i18n = createI18n("fr");
  // The bundled resources are shared by every instance: take the key back out.
  onTestFinished(() => void delete (resources.en.common as Record<string, unknown>).onlyInEnglish);
  i18n.addResource("en", "common", "onlyInEnglish", "Only in English");
  expect(i18n.t("onlyInEnglish" as never)).toBe("Only in English");
  expect(i18n.t("actions.cancel")).toBe("Annuler");
});

test("two renders at once in different languages share nothing", async () => {
  const fr = createI18n("fr");
  const en = createI18n("en");
  const Cancel = () => createElement("p", null, useTranslation().t("actions.cancel"));
  const page = (i18n: typeof fr) => renderToString(createElement(I18nextProvider, { i18n }, createElement(Cancel)));
  const [french, english] = await Promise.all([Promise.resolve().then(() => page(fr)), Promise.resolve().then(() => page(en))]);
  expect([french, english]).toEqual(["<p>Annuler</p>", "<p>Cancel</p>"]);
  // A language changed for one page (a saved choice) leaves the other's.
  await fr.changeLanguage("en");
  await en.changeLanguage("fr");
  expect([page(fr), page(en)]).toEqual(["<p>Cancel</p>", "<p>Annuler</p>"]);
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

test("the built-in agent is named Stem in both languages, from the messages its prompts read", () => {
  expect(createI18n("en").t("messages:agent.assistant.name")).toBe("Stem");
  expect(createI18n("fr").t("messages:agent.assistant.name")).toBe("Stem");
});

test("a shell's messages add their keys and never replace a public text or section", () => {
  const catalog = { workspace: { managerOnly: "Public" }, plain: "Text" };
  const merged = withShellMessages(catalog, {
    "fixture.entry": "Entry",
    "fixture.nested.deep": "Deep",
    "workspace.managerOnly": "Shell",
    "workspace.other": "Other",
    workspace: "Section",
    "plain.under": "Under a text",
    "": "Empty",
    "a..b": "Empty segment",
    "__proto__.polluted": "Polluted",
  });
  expect(merged).toEqual({
    workspace: { managerOnly: "Public", other: "Other" },
    plain: "Text",
    fixture: { entry: "Entry", nested: { deep: "Deep" } },
  });
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  // A copy: the catalog the domain reads stays as it was.
  expect(catalog).toEqual({ workspace: { managerOnly: "Public" }, plain: "Text" });
  expect(withShellMessages(catalog)).toEqual(catalog);
});
