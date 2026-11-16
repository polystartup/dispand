import type { Message, Text } from "@dispand/domain";
import { storedText } from "@dispand/domain/messages/index.ts";
import type { i18n } from "i18next";
import { useTranslation } from "react-i18next";
import { formatters } from "./format.ts";

/**
 * A server message in the page's language: a key of the shared `messages` namespace with its
 * values (a list as the language writes one, `count` picking a plural form), or the words that
 * came as they are. A key the page doesn't know reads as the generic message.
 */
export function messageText(t: i18n, text: Text | Message): string {
  if ("text" in text) return text.text;
  const { list } = formatters(t.language);
  const replace = Object.fromEntries(Object.entries(text.values ?? {}).map(([name, value]) => [name, Array.isArray(value) ? list(value) : value]));
  // Values go under `replace`, so none can stand for one of i18next's options.
  const options = { replace, ...(typeof replace.count === "number" && { count: replace.count }) };
  const key = `messages:${text.key}`;
  return t.exists(key, options) ? t.t(key as never, options) : t.t("errors.generic");
}

/** What a text column stored (a failure's key and values as JSON, or plain words from before) in the page's language. */
export const storedMessage = (t: i18n, value: string): string => messageText(t, storedText(value));

/** `storedMessage` in the page's current language; empty and absent stay as they are. */
export function useStored() {
  const { i18n } = useTranslation();
  return <V extends string | null | undefined>(value: V): V => (value ? (storedMessage(i18n, value) as V) : value);
}

/** `messageText` in the page's current language. */
export function useText() {
  const { i18n } = useTranslation();
  return (text: Text | Message) => messageText(i18n, text);
}
