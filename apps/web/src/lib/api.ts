import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { createORPCClient, mapEventIterator, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { SimpleCsrfProtectionLinkPlugin } from "@orpc/client/plugins";
import type { RouterClient } from "@orpc/server";
import type { Message, Router } from "@dispand/domain";
import type { i18n } from "i18next";
import { createI18n, type Language } from "./i18n.ts";
import { messageText } from "./message.ts";
import { noteRefusal } from "./organization-refusal.ts";

const translators = new Map<Language, i18n>();
const translator = (language: Language) => translators.get(language) ?? translators.set(language, createI18n(language)).get(language)!;

/**
 * The error a person reads, in `language`: a server message (`data.key`, `message()` in the
 * domain) translated with its values; text marked as external (an MCP server's, a plugin's) as it
 * came; a key the page doesn't know (one an embedding entry registered on the server) as the
 * server's own sentence, which `message()` rendered from its catalog; an error without a key as the
 * generic message, its details staying in the server's logs. Values are text: React escapes them where they are shown.
 */
export function translated(error: unknown, language: Language): unknown {
  if (!(error instanceof ORPCError)) return error;
  const data = (error.data ?? {}) as { key?: unknown; values?: Message["values"]; external?: unknown };
  if (data.external === true) return error;
  const t = translator(language);
  // shortcut: an error without a key reads as the generic message, whatever its code; a procedure that wants its words shown keys them or marks them external. Upgrade to per-code messages (not found, forbidden) if the generic one proves too vague.
  // A keyed error's message is rendered from the server's catalog, so it is safe to show when the page can't translate it (in English, whatever the page's language).
  error.message = typeof data.key === "string" ? messageText(t, data as Message, error.message) : t.t("errors.generic");
  return error;
}

/** Reads the page's language (`<html lang>`, kept by the root route) when a call fails. */
const pageLanguage = (): Language => (document.documentElement.lang === "fr" ? "fr" : "en");

/**
 * Translates every failed call's error (`translated`) before the page sees it, a stream's error
 * events included, and notes an organization's refusal for the page (`noteRefusal`).
 */
export const translateErrors = (language: () => Language = pageLanguage) => {
  const seen = (error: unknown) => {
    const shown = translated(error, language());
    noteRefusal(shown);
    return shown;
  };
  return async <T>({ next }: { next: () => Promise<T> }): Promise<T> => {
    let output: T;
    try {
      output = await next();
    } catch (error) {
      throw seen(error);
    }
    // A stream's call returns once it opens: its later errors come from the iterator.
    const iterator = output as AsyncIterator<unknown> & { [Symbol.asyncIterator]?: unknown };
    return typeof iterator?.[Symbol.asyncIterator] === "function" ? (mapEventIterator(iterator, { value: async (v) => v, error: async (e) => seen(e) }) as T) : output;
  };
};

type Workspace = { organizationId: string; workspaceId: string };
let workspace: Workspace | null = null;

/** Names the workspace the page works in, sent with every call; null names none and the server takes the person's only workspace. */
export function setWorkspace(next: Workspace | null) {
  workspace = next;
}

/** The headers naming the page's workspace, when it is known. */
export const workspaceHeaders = (): Record<string, string> =>
  workspace ? { "dispand-organization": workspace.organizationId, "dispand-workspace": workspace.workspaceId } : {};

/** Typed client of the oRPC API. Browser only: procedures are called from event handlers. */
export const api: RouterClient<Router> = createORPCClient(
  new RPCLink({
    url: () => `${window.location.origin}/api/rpc`,
    headers: workspaceHeaders,
    plugins: [new SimpleCsrfProtectionLinkPlugin()],
    interceptors: [translateErrors()],
  }),
);

/** Query options and mutation options for the same API, for TanStack Query. */
export const orpc = createTanstackQueryUtils(api);
