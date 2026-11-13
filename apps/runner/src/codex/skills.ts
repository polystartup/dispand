import { basename, dirname } from "node:path";
import type { UserInput } from "./protocol/v2/UserInput.ts";

type Skill = { name: string; path: string; enabled: boolean; pluginId?: string | null };
/** A local fallback package has the same namespace as the Claude plugin written beside it. */
const qualified = (s: Skill) => `${s.pluginId ?? basename(dirname(dirname(dirname(s.path))))}:${s.name}`;

export function skillInputs(text: string, skills: Skill[]): UserInput[] {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  const found = match ? skills.filter((s) => s.enabled && (s.name === match[1] || qualified(s) === match[1])) : [];
  if (found.length !== 1) return [{ type: "text", text, text_elements: [] }];
  const selected = found[0]!;
  return [{ type: "skill", name: selected.name, path: selected.path }, ...(match?.[2] ? [{ type: "text" as const, text: match[2], text_elements: [] }] : [])];
}


/** Keep plugin identities distinct; only unambiguous standalone skills use their bare name. */
export function skillCommands(skills: (Skill & { description: string })[]) {
  const enabled = skills.filter((s) => s.enabled);
  return enabled.map((s) => ({ name: s.pluginId || s.path.includes("/plugins/") || enabled.some((other) => other !== s && other.name === s.name) ? qualified(s) : s.name, description: s.description }));
}
