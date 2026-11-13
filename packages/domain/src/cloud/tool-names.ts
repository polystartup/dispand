// Function-tool names for the providers: `^[a-zA-Z0-9_-]{1,64}$`, unique, the same for the same
// list, and never one of the built-ins the cloud loop answers itself.
const RESERVED = new Set(["ask_user", "submit_outputs", "request_approval", "consult", "read_skill"]);
const MAX = 64;

function slug(label: string): string {
  const normalized = label
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "_");
  let start = 0;
  let end = normalized.length;
  while (start < end && normalized[start] === "_") start++;
  while (end > start && normalized[end - 1] === "_") end--;
  const s = normalized.slice(start, Math.min(end, start + MAX));
  return s === "" ? "tool" : s;
}

export function toolNames(refs: { key: string; label: string }[]): {
  toName(key: string): string;
  fromName(name: string): string | undefined;
} {
  const byKey = new Map<string, string>();
  const byName = new Map<string, string>();
  // Compared lowercased, so names that differ only by case (`READ_SKILL`) don't slip through.
  const taken = new Set([...RESERVED]);
  for (const { key, label } of refs) {
    const base = slug(label);
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) {
      const suffix = `_${n}`;
      name = base.slice(0, MAX - suffix.length) + suffix;
    }
    taken.add(name.toLowerCase());
    byKey.set(key, name);
    byName.set(name, key);
  }
  return {
    toName(key) {
      const name = byKey.get(key);
      if (name === undefined) throw new Error(`unknown tool key: ${key}`);
      return name;
    },
    fromName: (name) => byName.get(name),
  };
}
