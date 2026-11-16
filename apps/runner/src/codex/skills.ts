import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import { resolveSkillAlias } from "../native-skills.ts";
import type { UserInput } from "./protocol/v2/UserInput.ts";

type Skill = { name: string; path: string; enabled: boolean; pluginId?: string | null; scope?: string };
/** A local fallback package has the same namespace as the Claude plugin written beside it; Codex 0.167 already names a staged skill `<package>:<skill>`. */
const qualified = (s: Skill) => s.name.includes(":") ? s.name : `${s.pluginId ?? basename(dirname(dirname(dirname(s.path))))}:${s.name}`;

const staged = (s: Skill) => s.path.split(/[\\/]/).includes("plugins");
function commandName(s: Skill, skills: Skill[]): string {
  const base = (s: Skill) => s.pluginId || staged(s) ? qualified(s) : skills.some((o) => o !== s && o.name === s.name) ? `${s.scope ?? "local"}:${s.name}` : s.name;
  const name = base(s);
  return skills.some((other) => other !== s && base(other) === name) ? `${name}~${createHash("sha256").update(s.path).digest("hex").slice(0, 12)}` : name;
}

const SLASH = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;

/** A package alias (`native-skills.ts`) applies only when no catalog name matches exactly. */
export function skillInputs(text: string, skills: Skill[], aliases: { alias: string; namespace: string }[] = []): UserInput[] {
  const enabled = skills.filter((s) => s.enabled);
  const exactly = (t: string) => enabled.filter((s) => commandName(s, enabled) === SLASH.exec(t)?.[1]);
  if (!exactly(text).length) text = resolveSkillAlias(text, aliases);
  const match = SLASH.exec(text);
  const exact = exactly(text);
  const found = exact.length ? exact : match ? enabled.filter((s) => s.name === match[1] || qualified(s) === match[1] || (s.pluginId?.includes("@") && `${s.pluginId.split("@")[0]}:${s.name}` === match[1])) : [];
  if (found.length !== 1) return [{ type: "text", text, text_elements: [] }];
  const selected = found[0]!;
  return [{ type: "skill", name: selected.name, path: selected.path }, ...(match?.[2] ? [{ type: "text" as const, text: match[2], text_elements: [] }] : [])];
}

/** Catalog and invocation use the same identity, including scope collisions. */
export function skillCommands(skills: (Skill & { description: string })[]) {
  const enabled = skills.filter((s) => s.enabled);
  return enabled.map((s) => ({ name: commandName(s, enabled), description: s.description, ...(s.pluginId ? { nativeNamespace: s.pluginId } : {}) }));
}
