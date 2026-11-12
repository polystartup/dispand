import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { agents, agentSkills, harnesses, plugins, runners, skillFiles, skillPackages } from "../db/schema.ts";
import { pluginNativeKey, workspaceNativeKey } from "./native.ts";

/**
 * Whether an agent whose harness is on `runnerId` uses the package: the rule a runner's fetch
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
  return row !== undefined;
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
  const nativeKey = plugin ? pluginNativeKey(plugin) : !pkg.pluginId ? workspaceNativeKey(encoded) : undefined;
  return { name: pkg.name, ...(nativeKey ? { nativePlugin: `dispand-${pkg.pluginId ?? pkg.id}`, nativeKey } : {}), files: encoded };
}
