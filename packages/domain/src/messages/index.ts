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
export type MessageValues = Record<string, string | number>;
/** An error's data when its text reaches a person: what to translate, with what. */
export type Message = { key: MessageKey; values?: MessageValues };

const lookup = (path: string): unknown => path.split(".").reduce<unknown>((at, k) => (at as Record<string, unknown> | undefined)?.[k], en);

/** Whether `text` names one of the server messages. */
export function isMessageKey(text: string): text is MessageKey {
  return typeof lookup(text) === "string" || typeof lookup(`${text}_other`) === "string";
}

/** The English sentence, with i18next's plural forms (`_one`, `_other` by `count`) and `{{value}}`s. */
function english(key: MessageKey, values: MessageValues = {}): string {
  const plural = typeof values.count === "number" ? lookup(`${key}_${new Intl.PluralRules("en").select(values.count)}`) : undefined;
  const text = String(plural ?? lookup(key) ?? lookup(`${key}_other`));
  return text.replace(/{{(\w+)}}/g, (_, name: string) => String(values[name] ?? ""));
}

/** An error's options for a message to a person: `new ORPCError(code, message(key, values))`. */
export function message(key: MessageKey, values?: MessageValues): { message: string; data: Message } {
  return { message: english(key, values), data: values ? { key, values } : { key } };
}

/** An error's options for text the page shows as it came: an MCP server's or a plugin's own words. */
export function external(text: string): { message: string; data: { external: true } } {
  return { message: text, data: { external: true } };
}
