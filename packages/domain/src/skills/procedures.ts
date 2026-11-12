import { ORPCError } from "@orpc/server";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { agentUsingPackage } from "../agents/usage.ts";
import { PLATFORM_SKILL } from "../assistant/skill.ts";
import { plugins, skillFiles, skillPackages, skills as skillsTable, tools as toolsTable } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { authed, base } from "../rpc/context.ts";
import { StorableText } from "../workflows/model.ts";
import { MAX_DESCRIPTION, MAX_FILE_BYTES, MAX_FILES, PackageError, SKILL_NAME, skillMd, type SkillFile, splitSkillMd, validatePackage } from "./package.ts";

const owner = base.use(authed);

/** A file of a user-made skill, `path` inside the skill's folder. Bounds beyond these are `validatePackage`'s. */
const UploadedFile = z.object({
  path: z.string().max(255),
  base64: z.base64().max(Math.ceil(MAX_FILE_BYTES / 3) * 4),
});

const Fields = z.object({
  name: z.string().regex(SKILL_NAME, "lowercase letters, digits and hyphens, at most 64"),
  description: StorableText(MAX_DESCRIPTION).trim().min(1),
  /** The Markdown after `SKILL.md`'s frontmatter. */
  instructions: StorableText(100_000),
  /** Files besides `SKILL.md`. Omitted on update, the current ones are kept. */
  files: z.array(UploadedFile).max(MAX_FILES - 1).optional(),
  requiredToolIds: z.array(z.string().max(64)).max(20),
});
type Fields = z.infer<typeof Fields>;

const PackageId = z.object({ packageId: z.string().max(64) });

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Checks that every id is one of the owner's tools, and locks them (shared) so none is deleted
 * before the package that requires it is saved.
 */
async function requireTools(tx: Tx, ownerId: string, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const found = await tx
    .select({ id: toolsTable.id })
    .from(toolsTable)
    .where(and(inArray(toolsTable.id, unique), eq(toolsTable.ownerId, ownerId)))
    .for("share");
  if (found.length !== unique.length) throw new ORPCError("NOT_FOUND", { message: "Tool not found" });
}

function nameTaken(name: string) {
  return (err: unknown): never => {
    const e = err as { code?: unknown; cause?: { code?: unknown } };
    if (e.code === "23505" || e.cause?.code === "23505") throw new ORPCError("CONFLICT", { message: `A skill is already called “${name}”` });
    throw err;
  };
}

/** The package `validatePackage` accepts, or BAD_REQUEST with its reason (which names the file). */
function checked(files: SkillFile[]) {
  try {
    return validatePackage(files);
  } catch (e) {
    if (e instanceof PackageError) throw new ORPCError("BAD_REQUEST", { message: e.message });
    throw e;
  }
}

/** Stores the package's skills and files in place of its current ones. */
export async function store(tx: Tx, packageId: string, files: SkillFile[], skills: { name: string; description: string }[]) {
  await tx.delete(skillFiles).where(eq(skillFiles.packageId, packageId));
  await tx.delete(skillsTable).where(eq(skillsTable.packageId, packageId));
  await tx.insert(skillsTable).values(skills.map((s) => ({ id: newId("skill"), packageId, ...s })));
  await tx.insert(skillFiles).values(files.map((f) => ({ packageId, path: f.path, content: f.content })));
}

/** A user-made package's files: its `SKILL.md` from the fields, then `extra` (paths inside the skill). */
function userFiles(fields: Fields, extra: { path: string; content: Uint8Array }[]): SkillFile[] {
  return [
    { path: `${fields.name}/SKILL.md`, content: skillMd(fields.name, fields.description, fields.instructions) },
    ...extra.map((f) => ({ path: `${fields.name}/${f.path}`, content: f.content })),
  ];
}

const decoded = (files: NonNullable<Fields["files"]>) => files.map((f) => ({ path: f.path, content: Buffer.from(f.base64, "base64") }));

async function find(db: Db | Tx, ownerId: string, packageId: string, lock = false) {
  const query = db
    .select()
    .from(skillPackages)
    .where(and(eq(skillPackages.id, packageId), eq(skillPackages.ownerId, ownerId)));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Skill not found" });
  return row;
}

/** A plugin's package changes only with its plugin, the platform skill only with the application. */
function refuseReadOnly(row: typeof skillPackages.$inferSelect) {
  if (row.builtIn) throw new ORPCError("FORBIDDEN", { message: "The platform skill is built in: it is read-only" });
  if (row.pluginId !== null) throw new ORPCError("FORBIDDEN", { message: "Remove the plugin instead: its skills are read-only" });
}

/** The platform skill's name stays free for it (`assistant/skill.ts`). */
function refuseReservedName(name: string) {
  if (name === PLATFORM_SKILL) throw new ORPCError("CONFLICT", { message: `A skill is already called “${name}”` });
}

const create = owner.input(Fields).handler(async ({ input, context }) => {
  refuseReservedName(input.name);
  const files = userFiles(input, decoded(input.files ?? []));
  const { skills } = checked(files);
  const packageId = newId("skillpkg");
  await context.db
    .transaction(async (tx) => {
      await requireTools(tx, context.ownerId, input.requiredToolIds);
      await tx.insert(skillPackages).values({
        id: packageId,
        ownerId: context.ownerId,
        name: input.name,
        description: input.description,
        requiredToolIds: input.requiredToolIds,
      });
      await store(tx, packageId, files, skills);
    })
    .catch(nameTaken(input.name));
  return { packageId };
});

const update = owner.input(Fields.extend(PackageId.shape)).handler(async ({ input, context }) => {
  const { packageId, ...fields } = input;
  await context.db
    .transaction(async (tx) => {
      const row = await find(tx, context.ownerId, packageId, true);
      refuseReadOnly(row);
      refuseReservedName(fields.name);
      await requireTools(tx, context.ownerId, fields.requiredToolIds);
      let extra;
      if (fields.files) extra = decoded(fields.files);
      else {
        // Keeps the current files but SKILL.md, under the (maybe new) name.
        const prefix = `${row.name}/`;
        const current = await tx.select().from(skillFiles).where(eq(skillFiles.packageId, packageId));
        extra = current
          .filter((f) => f.path.startsWith(prefix) && f.path !== `${prefix}SKILL.md`)
          .map((f) => ({ path: f.path.slice(prefix.length), content: f.content }));
      }
      const files = userFiles(fields, extra);
      const { skills } = checked(files);
      await tx
        .update(skillPackages)
        .set({ name: fields.name, description: fields.description, requiredToolIds: fields.requiredToolIds, updatedAt: sql`now()` })
        .where(eq(skillPackages.id, packageId));
      await store(tx, packageId, files, skills);
    })
    .catch(nameTaken(fields.name));
  return { packageId };
});

const remove = owner.input(PackageId).handler(async ({ input, context }) => {
  await context.db.transaction(async (tx) => {
    refuseReadOnly(await find(tx, context.ownerId, input.packageId, true));
    const agent = await agentUsingPackage(tx, input.packageId);
    if (agent) throw new ORPCError("CONFLICT", { message: `The agent “${agent}” uses this skill` });
    await tx.delete(skillPackages).where(eq(skillPackages.id, input.packageId));
  });
});

type PackageRow = typeof skillPackages.$inferSelect;

/** The list view of packages: their skills, plugin and required tools. */
async function views(db: Db, rows: PackageRow[]) {
  const ids = rows.map((r) => r.id);
  const skillRows = ids.length
    ? await db.select().from(skillsTable).where(inArray(skillsTable.packageId, ids)).orderBy(asc(skillsTable.name))
    : [];
  const pluginIds = rows.flatMap((r) => (r.pluginId ? [r.pluginId] : []));
  const toolIds = [...new Set(rows.flatMap((r) => r.requiredToolIds))];
  const toolRows = toolIds.length ? await db.select({ id: toolsTable.id, name: toolsTable.name }).from(toolsTable).where(inArray(toolsTable.id, toolIds)) : [];
  const pluginRows = pluginIds.length ? await db.select({ id: plugins.id, name: plugins.name }).from(plugins).where(inArray(plugins.id, pluginIds)) : [];
  return rows.map((r) => ({
    packageId: r.id,
    name: r.name,
    description: r.description,
    builtIn: r.builtIn,
    plugin: pluginRows.find((p) => p.id === r.pluginId) ?? null,
    skills: skillRows.filter((s) => s.packageId === r.id).map((s) => ({ name: s.name, description: s.description })),
    requiredTools: r.requiredToolIds.flatMap((id) => toolRows.filter((t) => t.id === id)),
  }));
}

const list = owner.handler(async ({ context }) => {
  const rows = await context.db
    .select()
    .from(skillPackages)
    .where(eq(skillPackages.ownerId, context.ownerId))
    .orderBy(asc(skillPackages.name));
  return views(context.db, rows);
});

const get = owner.input(PackageId).handler(async ({ input, context }) => {
  const row = await find(context.db, context.ownerId, input.packageId);
  const [view] = await views(context.db, [row]);
  const files = await context.db
    .select({ path: skillFiles.path, size: sql<number>`octet_length(${skillFiles.content})`.mapWith(Number) })
    .from(skillFiles)
    .where(eq(skillFiles.packageId, row.id))
    .orderBy(asc(skillFiles.path));
  // The package's own skill's SKILL.md (a user-made package has one skill, named like it).
  const [md] = await context.db
    .select({ content: skillFiles.content })
    .from(skillFiles)
    .where(and(eq(skillFiles.packageId, row.id), eq(skillFiles.path, `${row.name}/SKILL.md`)));
  const skillMdText = md ? new TextDecoder().decode(md.content) : null;
  return {
    ...view!,
    files,
    skillMd: skillMdText,
    instructions: skillMdText === null ? null : (splitSkillMd(skillMdText)?.body.replace(/^\r?\n/, "") ?? null),
  };
});

export const skills = { create, update, delete: remove, list, get };
