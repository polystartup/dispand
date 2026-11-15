import enMessages from "@dispand/domain/messages/en.json";
import frMessages from "@dispand/domain/messages/fr.json";
import { createInstance, type i18n } from "i18next";
import enAssistant from "../locales/en/assistant.json";
import enCommon from "../locales/en/common.json";
import enShell from "../locales/en/shell.json";
import frAssistant from "../locales/fr/assistant.json";
import frCommon from "../locales/fr/common.json";
import frShell from "../locales/fr/shell.json";

// The page's strings, one namespace per area, in English and French (`locales/<language>/`), and
// the `messages` namespace: what the server and the page share (`packages/domain/src/messages/`),
// the built-in agent's name first. A key missing in French falls back to English.

export const resources = {
  en: { common: enCommon, shell: enShell, assistant: enAssistant, messages: enMessages },
  fr: { common: frCommon, shell: frShell, assistant: frAssistant, messages: frMessages },
} as const;

export type Language = keyof typeof resources;

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: (typeof resources)["en"];
  }
}

/** The first of English or French among the browser's languages, in its order; otherwise English. */
export function detectLanguage(languages: readonly string[]): Language {
  for (const tag of languages) {
    const base = tag.trim().toLowerCase().split("-")[0];
    if (base === "en" || base === "fr") return base;
  }
  return "en";
}

/** An `Accept-Language` header's languages, the preferred first (by `q`, then their order), without the refused (`q=0`). */
export function acceptedLanguages(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part) => {
      const [tag = "", ...params] = part.split(";").map((p) => p.trim());
      const q = params.find((p) => p.startsWith("q="));
      return { tag, q: q ? Number(q.slice(2)) : 1 };
    })
    .filter(({ tag, q }) => tag && q > 0)
    .sort((a, b) => b.q - a.q)
    .map(({ tag }) => tag);
}

/** The page's language: the one the user saved, else their browser's (`Accept-Language`). */
export function resolveLanguage(saved: Language | null | undefined, acceptLanguage: string | null): Language {
  return saved ?? detectLanguage(acceptedLanguages(acceptLanguage));
}

/** One i18next instance per page render (one per request on the server), already in `language`. */
export function createI18n(language: Language): i18n {
  const instance = createInstance();
  // Not registered as react-i18next's global: the page hands it down with an I18nextProvider.
  void instance.init({
    lng: language,
    fallbackLng: "en",
    supportedLngs: ["en", "fr"],
    resources,
    defaultNS: "common",
    // React escapes what it renders.
    interpolation: { escapeValue: false },
    // Resources are bundled: ready before the first render, on the server too.
    initAsync: false,
    react: { useSuspense: false },
  });
  return instance;
}
