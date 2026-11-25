import en from "./en.json" with { type: "json" };
import fr from "./fr.json" with { type: "json" };

// What the server says to a person: a key of these resources and its values, which the page
// translates (`apps/web/src/lib/api.ts`), never a sentence built here. The English sentence goes
// along as the error's message, for agents (a tool call's refusal) and for the logs.

type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];
type Singular<K extends string> = K extends `${infer Base}_${"zero" | "one" | "two" | "few" | "many" | "other"}` ? Base : K;

/** A server message's key: every sentence of `en.json`, a plural's forms under one key. */
export type MessageKey = Singular<Leaves<typeof resources.en>>;
/** A list value reads as the language writes a list ("A, B and C"): the page formats it, the English sentence here. */
export type MessageValues = Record<string, string | number | string[]>;
/** An error's data when its text reaches a person: what to translate, with what. */
export type Message = { key: MessageKey; values?: MessageValues };

// Copies: `registerMessages` adds to these, never to the bundled files' own objects.
const resources = { en: structuredClone(en), fr: structuredClone(fr) };
/** A language the server writes in: what a push says is rendered here, in the person's language. */
export type Language = keyof typeof resources;

const lookup = (path: string, language: Language = "en"): unknown =>
  path.split(".").reduce<unknown>((at, k) => (at as Record<string, unknown> | undefined)?.[k], resources[language]);

/**
 * Adds messages an embedding entry ships for its own refusals (a database adapter's limits, for
 * example): `{ "area.key": "Sentence" }` per language, before the first request.
 */
export function registerMessages(locale: string, entries: Record<string, string>): void {
  const root = ((resources as Record<string, unknown>)[locale] ??= {}) as Record<string, unknown>;
  for (const [key, text] of Object.entries(entries)) {
    const path = key.split(".");
    const parent = path.slice(0, -1).reduce<Record<string, unknown>>((at, k) => (at[k] ??= {}) as Record<string, unknown>, root);
    parent[path.at(-1)!] = text;
  }
}

/** Whether `text` names one of the server messages. */
export function isMessageKey(text: string): text is MessageKey {
  return typeof lookup(text) === "string" || typeof lookup(`${text}_other`) === "string";
}

/** The sentence in `language`, with i18next's plural forms (`_one`, `_other` by `count`) and `{{value}}`s. */
export function rendered(language: Language, key: MessageKey, values: MessageValues = {}): string {
  const plural = typeof values.count === "number" ? lookup(`${key}_${new Intl.PluralRules(language).select(values.count)}`, language) : undefined;
  const text = String(plural ?? lookup(key, language) ?? lookup(`${key}_other`, language));
  const shown = (value: MessageValues[string] | undefined) => (Array.isArray(value) ? new Intl.ListFormat(language).format(value) : String(value ?? ""));
  return text.replace(/{{(\w+)}}/g, (_, name: string) => shown(values[name]));
}

/** The English sentence, for agents and the logs. */
export const english = (key: MessageKey, values: MessageValues = {}): string => rendered("en", key, values);

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

/** An error that carries its message for a person: the English sentence as its `message`, the key and values as `say`, and `stored` for a text column. */
export class SayError extends Error {
  readonly say: Message;
  constructor(key: MessageKey, values?: MessageValues) {
    const { message: text, data } = message(key, values);
    super(text);
    this.say = data;
  }
  get stored(): string {
    return stored(this.say.key, this.say.values);
  }
}

/**
 * A failure kept in a text column (a step's, a Job's, a tool's, a poll's): the message as JSON,
 * so each reader shows it in its own language (`storedText`). A row written before holds plain
 * words, shown as stored.
 */
export const stored = (key: MessageKey, values?: MessageValues): string => JSON.stringify(say(key, values));

/** Words that came from outside, stored as they are: one shaped like JSON is wrapped, so it can never read as a stored message. */
export const plainText = (value: string): string => (value.trimStart().startsWith("{") ? JSON.stringify({ text: value }) : value);

/** What a column holds, for a person: the keyed message it was stored as, else its words as they came. */
export function storedText(value: string): Text {
  try {
    const parsed = JSON.parse(value) as { key?: unknown; values?: unknown; text?: unknown } | null;
    if (typeof parsed?.text === "string" && parsed.key === undefined) return { text: parsed.text };
    if (typeof parsed?.key === "string" && isMessageKey(parsed.key) && (parsed.values === undefined || (typeof parsed.values === "object" && parsed.values !== null))) return parsed as Message;
  } catch {
    // plain words
  }
  return { text: value };
}

/** What a column holds, as an English sentence: for an agent, a log, or a comparison. */
export const storedSentence = (value: string): string => sentence(storedText(value));
