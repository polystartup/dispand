import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { SimpleCsrfProtectionLinkPlugin } from "@orpc/client/plugins";
import type { RouterClient } from "@orpc/server";
import type { Router } from "@dispand/domain";
import type { i18n } from "i18next";
import { createI18n, type Language } from "./i18n.ts";

const translators = new Map<Language, i18n>();
const translator = (language: Language) => translators.get(language) ?? translators.set(language, createI18n(language)).get(language)!;

/**
 * The error a person reads, in `language`: a server message (`data.key`, `message()` in the
 * domain) translated with its values; text marked as external (an MCP server's, a plugin's) as it
 * came; an internal error, or a key the page doesn't know, as the generic message, its details
 * staying in the server's logs. Values are text: React escapes them where they are shown.
 */
export function translated(error: unknown, language: Language): unknown {
  if (!(error instanceof ORPCError)) return error;
  const data = (error.data ?? {}) as { key?: unknown; values?: Record<string, unknown>; external?: unknown };
  if (data.external === true) return error;
  const t = translator(language);
  const key = typeof data.key === "string" ? `messages:${data.key}` : undefined;
  // Values go under `replace`, so none can stand for one of i18next's options; `count` picks a plural form.
  const options = { replace: data.values, ...(typeof data.values?.count === "number" && { count: data.values.count }) };
  if (key && t.exists(key, options)) error.message = t.t(key as never, options);
  // shortcut: an error without a key keeps its English text until Task 4 has keyed every procedure; then every one is generic.
  else if (key || error.code === "INTERNAL_SERVER_ERROR") error.message = t.t("errors.generic");
  return error;
}

/** Reads the page's language (`<html lang>`, kept by the root route) when a call fails. */
const pageLanguage = (): Language => (document.documentElement.lang === "fr" ? "fr" : "en");

/** Translates every failed call's error (`translated`) before the page sees it. */
export const translateErrors =
  (language: () => Language = pageLanguage) =>
  async <T>({ next }: { next: () => Promise<T> }): Promise<T> => {
    try {
      return await next();
    } catch (error) {
      throw translated(error, language());
    }
  };

/** Typed client of the oRPC API. Browser only: procedures are called from event handlers. */
export const api: RouterClient<Router> = createORPCClient(
  new RPCLink({
    url: () => `${window.location.origin}/api/rpc`,
    plugins: [new SimpleCsrfProtectionLinkPlugin()],
    interceptors: [translateErrors()],
  }),
);

/** Query options and mutation options for the same API, for TanStack Query. */
export const orpc = createTanstackQueryUtils(api);
