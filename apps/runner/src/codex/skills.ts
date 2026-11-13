import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import type { UserInput } from "./protocol/v2/UserInput.ts";

type Skill = { name: string; path: string; enabled: boolean; pluginId?: string | null; scope?: string };
/** A local fallback package has the same namespace as the Claude plugin written beside it. */
const qualified = (s: Skill) => `${s.pluginId ?? basename(dirname(dirname(dirname(s.path))))}:${s.name}`;

const staged = (s: Skill) => s.path.split(/[\\/]/).includes("plugins");
function commandName(s: Skill, skills: Skill[]): string {
  const base = (s: Skill) => s.pluginId || staged(s) ? qualified(s) : skills.some((o) => o !== s && o.name === s.name) ? `${s.scope ?? "local"}:${s.name}` : s.name;
  const name = base(s);
  return skills.some((other) => other !== s && base(other) === name) ? `${name}~${createHash("sha256").update(s.path).digest("hex").slice(0, 12)}` : name;
}

export function skillInputs(text: string, skills: Skill[]): UserInput[] {
  const enabled = skills.filter((s) => s.enabled);
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  const found = match ? enabled.filter((s) => s.name === match[1] || commandName(s, enabled) === match[1] || qualified(s) === match[1] || (s.pluginId?.includes("@") && `${s.pluginId.split("@")[0]}:${s.name}` === match[1])) : [];
  if (found.length !== 1) return [{ type: "text", text, text_elements: [] }];
  const selected = found[0]!;
  return [{ type: "skill", name: selected.name, path: selected.path }, ...(match?.[2] ? [{ type: "text" as const, text: match[2], text_elements: [] }] : [])];
}

/** Catalog and invocation use the same identity, including scope collisions. */
export function skillCommands(skills: (Skill & { description: string })[]) {
  const enabled = skills.filter((s) => s.enabled);
  return enabled.map((s) => ({ name: commandName(s, enabled), description: s.description }));
}
