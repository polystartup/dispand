/** A tool an agent gets: chosen for it (`explicit`), required by its skill packages (`lockedBy`), or both. */
export type EffectiveTool = { toolId: string; explicit: boolean; lockedBy: string[] };

/**
 * The tools an agent gets from its explicit tools and its skill packages' required ones, in the
 * order they first appear. A required tool is locked by every package that requires it: it goes
 * when the last of them does, unless it is also explicit.
 */
export function effectiveTools(explicit: string[], packages: { name: string; requiredToolIds: string[] }[]): EffectiveTool[] {
  const out = new Map<string, EffectiveTool>();
  for (const toolId of explicit) out.set(toolId, { toolId, explicit: true, lockedBy: [] });
  for (const pkg of packages) {
    for (const toolId of pkg.requiredToolIds) {
      const tool = out.get(toolId) ?? { toolId, explicit: false, lockedBy: [] };
      if (!tool.lockedBy.includes(pkg.name)) tool.lockedBy.push(pkg.name);
      out.set(toolId, tool);
    }
  }
  return [...out.values()];
}
