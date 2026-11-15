import en from "./en.json";

// What the server says to a person: a key of these resources and its values, which the page
// translates (`apps/web/src/lib/api.ts`), never a sentence built here. The English sentence goes
// along as the error's message, for agents (a tool call's refusal) and for the logs.

type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];
type Singular<K extends string> = K extends `${infer Base}_${"zero" | "one" | "two" | "few" | "many" | "other"}` ? Base : K;

/** A server message's key: every sentence of `en.json`, a plural's forms under one key. */
export type MessageKey = Singular<Leaves<typeof en>>;
/** A list value reads as the language writes a list ("A, B and C"): the page formats it, the English sentence here. */
export type MessageValues = Record<string, string | number | string[]>;
/** An error's data when its text reaches a person: what to translate, with what. */
export type Message = { key: MessageKey; values?: MessageValues };

const lookup = (path: string): unknown => path.split(".").reduce<unknown>((at, k) => (at as Record<string, unknown> | undefined)?.[k], en);

/** Whether `text` names one of the server messages. */
export function isMessageKey(text: string): text is MessageKey {
  return typeof lookup(text) === "string" || typeof lookup(`${text}_other`) === "string";
}

/** The English sentence, with i18next's plural forms (`_one`, `_other` by `count`) and `{{value}}`s. */
export function english(key: MessageKey, values: MessageValues = {}): string {
  const plural = typeof values.count === "number" ? lookup(`${key}_${new Intl.PluralRules("en").select(values.count)}`) : undefined;
  const text = String(plural ?? lookup(key) ?? lookup(`${key}_other`));
  const shown = (value: MessageValues[string] | undefined) => (Array.isArray(value) ? new Intl.ListFormat("en").format(value) : String(value ?? ""));
  return text.replace(/{{(\w+)}}/g, (_, name: string) => shown(values[name]));
}

/** An error's options for a message to a person: `new ORPCError(code, message(key, values))`. */
export function message(key: MessageKey, values?: MessageValues): { message: string; data: Message } {
  return { message: english(key, values), data: values ? { key, values } : { key } };
}

/** A message as data a procedure returns, for the page to translate: `say(key, values)`. */
export const say = (key: MessageKey, values?: MessageValues): Message => message(key, values).data;

/** An error's options for text the page shows as it came: an MCP server's or a plugin's own words. */
export function external(text: string): { message: string; data: { external: true } } {
  return { message: text, data: { external: true } };
}

/** Person-facing text a procedure returns as data: a message, or words shown as they came (a plugin's, an MCP server's, another area's not yet keyed). */
export type Text = Message | { text: string };

/** Why a call failed, as data: the keyed message it carried, else its words as they came. */
export function reasonOf(err: { message: string; data?: unknown }): Text {
  const data = err.data as { key?: unknown } | undefined;
  return typeof data?.key === "string" && isMessageKey(data.key) ? (err.data as Message) : { text: err.message };
}

/** A `Text` as an English sentence, for an agent: its tool results stay English, never keys. */
export const sentence = (text: Text): string => ("text" in text ? text.text : english(text.key, text.values));
