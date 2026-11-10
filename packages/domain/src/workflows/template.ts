/** `{{key.field}}`, spaces allowed inside the braces. Pure: imported by the web editor too. */
const VARIABLE = /\{\{\s*([a-z0-9_]+)\.([A-Za-z0-9_]+)\s*\}\}/g;

export type Reference = { key: string; field: string };

/** Every `{{key.field}}` in `prompt`, in order (repeats included). */
export function references(prompt: string): Reference[] {
  return [...prompt.matchAll(VARIABLE)].map((m) => ({ key: m[1]!, field: m[2]! }));
}

/** Replaces `{{key.field}}` with `values[key][field]`; an unknown variable stays visible as `{{key.field}}`. */
export function renderTemplate(prompt: string, values: Record<string, Record<string, string>>): string {
  return prompt.replace(VARIABLE, (_, key: string, field: string) => {
    const value = Object.hasOwn(values, key) && Object.hasOwn(values[key]!, field) ? values[key]![field] : undefined;
    return value ?? `{{${key}.${field}}}`;
  });
}

/** Rewrites every `{{from.field}}` to `{{to.field}}`. */
export function renameReferences(prompt: string, from: string, to: string): string {
  return prompt.replace(VARIABLE, (whole, key: string, field: string) => (key === from ? `{{${to}.${field}}}` : whole));
}
