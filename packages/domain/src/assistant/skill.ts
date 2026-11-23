import { globSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { organizationMembers, skillFiles, skillPackages, workspaces } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { errorKind, logError } from "../log.ts";
import { ASSISTANT_NAME } from "../engine/job-def.ts";
import { type SkillFile, validatePackage } from "../skills/package.ts";
import { store } from "../skills/procedures.ts";
import { emitLog, inSpan, tracer } from "../telemetry/index.ts";

// The platform skill: what the Assistant knows of Dispand, shipped with the application. Its
// files are bundled from `./skill/` at build time, with `{{assistant}}` written as its shown name, so the package is the build's: each workspace
// has one built-in package, read-only to everyone, whose files a start replaces with these.

const traces = tracer("assistant");

/** The package's name, and its one skill's. */
export const PLATFORM_SKILL = "dispand-platform";

const skillDirectory = fileURLToPath(new URL("./skill/", import.meta.url));

/** The build's files of the platform skill, as `<skill>/<path>`. */
export const PLATFORM_SKILL_FILES: SkillFile[] = globSync("**/*", { cwd: skillDirectory, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => {
    const path = join(entry.parentPath, entry.name);
    const text = readFileSync(path, "utf8").replaceAll("{{assistant}}", ASSISTANT_NAME);
    return { path: relative(skillDirectory, path).split(sep).join("/"), content: new TextEncoder().encode(text) };
  })
  .sort((a, b) => (a.path < b.path ? -1 : 1));

const { skills: SKILLS } = validatePackage(PLATFORM_SKILL_FILES);

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(b);

/**
 * Writes the workspace's platform skill from the build's files, unless it holds them already, and
 * gives its id; `ownerId` is recorded as its creator when it is made. One built-in package per
 * workspace whatever runs this at once (the partial unique index, then a row lock).
 */
export async function syncPlatformSkill(db: Db | Tx, workspaceId: string, ownerId: string): Promise<string> {
  return inSpan(traces, "assistant.skill.sync", {}, errorKind, (span) =>
    db.transaction(async (tx) => {
      const description = SKILLS[0]!.description;
      await tx.insert(skillPackages).values({ id: newId("skillpkg"), ownerId, workspaceId, name: PLATFORM_SKILL, description, builtIn: true }).onConflictDoNothing();
      const [pkg] = await tx
        .select({ id: skillPackages.id })
        .from(skillPackages)
        .where(and(eq(skillPackages.workspaceId, workspaceId), eq(skillPackages.builtIn, true)))
        .for("update");
      // Only a user's package of that name, made before names were kept for it, stops the insert.
      if (!pkg) throw new Error(`a skill is already called ${PLATFORM_SKILL}`);
      const current = await tx.select({ path: skillFiles.path, content: skillFiles.content }).from(skillFiles).where(eq(skillFiles.packageId, pkg.id));
      const unchanged =
        current.length === PLATFORM_SKILL_FILES.length && PLATFORM_SKILL_FILES.every((f) => current.some((c) => c.path === f.path && same(c.content, f.content)));
      span.setAttributes({ "dispand.skill.package.id": pkg.id, "dispand.result": unchanged ? "unchanged" : "written", "dispand.files": PLATFORM_SKILL_FILES.length });
      if (unchanged) return pkg.id;
      await tx.update(skillPackages).set({ name: PLATFORM_SKILL, description, updatedAt: sql`now()` }).where(eq(skillPackages.id, pkg.id));
      await store(tx, pkg.id, PLATFORM_SKILL_FILES, SKILLS);
      emitLog("assistant", "info", "assistant.skill.written", { "dispand.skill.package.id": pkg.id, "dispand.files": PLATFORM_SKILL_FILES.length });
      return pkg.id;
    }),
  );
}

/** At server start: every workspace's platform skill holds this build's files. A failure is logged and doesn't stop the server. */
export async function syncPlatformSkills(db: Db): Promise<void> {
  const rows = await db.select({ workspaceId: workspaces.id, ownerId: organizationMembers.userId }).from(workspaces)
    .innerJoin(organizationMembers, and(eq(organizationMembers.organizationId, workspaces.organizationId), eq(organizationMembers.role, "owner")));
  for (const { workspaceId, ownerId } of rows) {
    await syncPlatformSkill(db, workspaceId, ownerId).catch((err: unknown) => logError("assistant.skill.sync failed", err));
  }
}

/** The workspace's platform skill package, or null before it was written. */
export async function platformSkillOf(db: Db | Tx, workspaceId: string): Promise<string | null> {
  const [pkg] = await db
    .select({ id: skillPackages.id })
    .from(skillPackages)
    .where(and(eq(skillPackages.workspaceId, workspaceId), eq(skillPackages.builtIn, true)));
  return pkg?.id ?? null;
}
