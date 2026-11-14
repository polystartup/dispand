import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { agents, agentSkills, harnesses, plugins, runners, skillFiles, skillPackages, runs, stepRuns, skillFileUpstream } from "../db/schema.ts";
import { pluginNativeKey, workspaceNativeKey } from "./native.ts";

/**
 * Whether an agent on `runnerId` uses the package, or its Assistant conversation invoked it: the rule a runner's fetch
 * is served by, and so the rule a start follows before it names a package to that runner.
 */
export async function usedOnRunner(db: Db, runnerId: string, packageId: string): Promise<boolean> {
  const [row] = await db
    .select({ agentId: agentSkills.agentId })
    .from(agentSkills)
    .innerJoin(agents, eq(agents.id, agentSkills.agentId))
    .innerJoin(harnesses, eq(harnesses.id, agents.harnessId))
    .where(and(eq(agentSkills.packageId, packageId), eq(harnesses.runnerId, runnerId)))
    .limit(1);
  if (row) return true;
  const selected = await db.select({ snapshot: runs.snapshot }).from(runs)
    .innerJoin(stepRuns, eq(stepRuns.runId, runs.id))
    .innerJoin(runners, and(eq(runners.id, stepRuns.runnerId), eq(runners.ownerId, runs.ownerId)))
    .innerJoin(agents, and(eq(agents.id, runs.agentId), eq(agents.builtIn, "assistant")))
    .where(and(eq(stepRuns.runnerId, runnerId), eq(agents.ownerId, runs.ownerId)));
  return selected.some((r) => r.snapshot?.invokedSkills?.includes(packageId));
}

/** Whether a plugin's package differs from the plugin's own files: one changed, added or removed by its owner. */
export async function filesOverridden(db: Db, packageId: string): Promise<boolean> {
  const [mine, theirs] = await Promise.all([
    db.select({ path: skillFiles.path, content: skillFiles.content }).from(skillFiles).where(eq(skillFiles.packageId, packageId)),
    db.select({ path: skillFileUpstream.path, content: skillFileUpstream.content }).from(skillFileUpstream).where(eq(skillFileUpstream.packageId, packageId)),
  ]);
  return mine.length !== theirs.length || mine.some((f) => !theirs.some((u) => u.path === f.path && Buffer.from(u.content).equals(Buffer.from(f.content))));
}

/**
 * A skill package as `GET /runner/packages/<id>` sends it to a runner: its name and files
 * (base64). Only a package of the runner's owner that an agent on that runner uses; null
 * (404) for anything else, so a runner learns nothing about other packages.
 */
export async function packageForRunner(db: Db, runnerId: string, packageId: string): Promise<{ name: string; nativePlugin?: string; nativeKey?: string; files: { path: string; base64: string }[] } | null> {
  const [pkg] = await db
    .select({ id: skillPackages.id, name: skillPackages.name, pluginId: skillPackages.pluginId })
    .from(skillPackages)
    .innerJoin(runners, eq(runners.ownerId, skillPackages.ownerId))
    .where(and(eq(skillPackages.id, packageId), eq(runners.id, runnerId)));
  if (!pkg || !(await usedOnRunner(db, runnerId, pkg.id))) return null;
  const files = await db.select({ path: skillFiles.path, content: skillFiles.content }).from(skillFiles).where(eq(skillFiles.packageId, pkg.id));
  const encoded = files.map((f) => ({ path: f.path, base64: Buffer.from(f.content).toString("base64") }));
  const [plugin] = pkg.pluginId ? await db.select().from(plugins).where(eq(plugins.id, pkg.pluginId)) : [];
  // A plugin's package its owner changed isn't what the plugin's native install holds: its files are sent.
  const nativeKey = plugin ? ((await filesOverridden(db, pkg.id)) ? undefined : pluginNativeKey(plugin)) : !pkg.pluginId ? workspaceNativeKey(encoded) : undefined;
  return { name: pkg.name, ...(nativeKey ? { nativePlugin: `dispand-${pkg.pluginId ?? pkg.id}`, nativeKey } : {}), files: encoded };
}
