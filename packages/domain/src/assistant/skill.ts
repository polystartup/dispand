import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { skillFiles, skillPackages, user } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { errorKind, logError } from "../log.ts";
import { type SkillFile, validatePackage } from "../skills/package.ts";
import { store } from "../skills/procedures.ts";
import { emitLog, inSpan, tracer } from "../telemetry/index.ts";

// The platform skill: what the Assistant knows of Dispand, shipped with the application. Its
// files are bundled from `./skill/` at build time, so the package is the build's: each owner
// has one built-in package, read-only to everyone, whose files a start replaces with these.

const traces = tracer("assistant");

/** The package's name, and its one skill's. */
export const PLATFORM_SKILL = "dispand-platform";

/** Vite's `import.meta.glob` (vite and vitest bundle the domain's sources), as far as it is used here. */
type Glob = { glob(pattern: string, options: { query: "?raw"; import: "default"; eager: true }): Record<string, string> };

const bundled = (import.meta as unknown as Glob).glob("./skill/**/*", { query: "?raw", import: "default", eager: true });

/** The build's files of the platform skill, as `<skill>/<path>`. */
export const PLATFORM_SKILL_FILES: SkillFile[] = Object.entries(bundled)
  .map(([path, text]) => ({ path: path.slice("./skill/".length), content: new TextEncoder().encode(text) }))
  .sort((a, b) => (a.path < b.path ? -1 : 1));

const { skills: SKILLS } = validatePackage(PLATFORM_SKILL_FILES);

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(b);

/**
 * Writes the owner's platform skill from the build's files, unless it holds them already, and
 * gives its id. One built-in package per owner whatever runs this at once (the partial unique
 * index, then a row lock).
 */
export async function syncPlatformSkill(db: Db | Tx, ownerId: string): Promise<string> {
  return inSpan(traces, "assistant.skill.sync", {}, errorKind, (span) =>
    db.transaction(async (tx) => {
      const description = SKILLS[0]!.description;
      await tx.insert(skillPackages).values({ id: newId("skillpkg"), ownerId, name: PLATFORM_SKILL, description, builtIn: true }).onConflictDoNothing();
      const [pkg] = await tx
        .select({ id: skillPackages.id })
        .from(skillPackages)
        .where(and(eq(skillPackages.ownerId, ownerId), eq(skillPackages.builtIn, true)))
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

/** At server start: every owner's platform skill holds this build's files. A failure is logged and doesn't stop the server. */
export async function syncPlatformSkills(db: Db): Promise<void> {
  for (const { id } of await db.select({ id: user.id }).from(user)) {
    await syncPlatformSkill(db, id).catch((err: unknown) => logError("assistant.skill.sync failed", err));
  }
}

/** The owner's platform skill package, or null before it was written. */
export async function platformSkillOf(db: Db | Tx, ownerId: string): Promise<string | null> {
  const [pkg] = await db
    .select({ id: skillPackages.id })
    .from(skillPackages)
    .where(and(eq(skillPackages.ownerId, ownerId), eq(skillPackages.builtIn, true)));
  return pkg?.id ?? null;
}
