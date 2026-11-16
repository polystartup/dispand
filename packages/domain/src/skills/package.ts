import { isSafeRelativePath, storable } from "@dispand/runner-protocol";
import { parse, stringify } from "yaml";
import { message, type Message, type MessageKey, type MessageValues } from "../messages/index.ts";

/** A skill's name, which is also its folder in a package; package names follow it too. */
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_FILES = 500;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
/** Claude Code's limit on a skill's description. */
export const MAX_DESCRIPTION = 1024;

/** A file of a skill package: `path` is `<skill>/<path inside the skill>`. */
export type SkillFile = { path: string; content: Uint8Array };

/** Why a package can't be stored; `path` names the file at fault, when there is one. */
export class PackageError extends Error {
  readonly say: Message;
  constructor(
    key: MessageKey,
    readonly path?: string,
    values: MessageValues = {},
  ) {
    const { message: text, data } = message(key, path === undefined ? values : { ...values, path });
    super(text);
    this.say = data;
    this.name = "PackageError";
  }
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** The YAML frontmatter of a `SKILL.md` and the Markdown after it; null without a frontmatter. */
export function splitSkillMd(text: string): { frontmatter: string; body: string } | null {
  const match = FRONTMATTER.exec(text);
  return match ? { frontmatter: match[1]!, body: text.slice(match[0].length) } : null;
}

/** A `SKILL.md` for a user-made skill: its frontmatter (`name`, `description`) then the instructions. */
export function skillMd(name: string, description: string, instructions: string): Uint8Array {
  return new TextEncoder().encode(`---\n${stringify({ name, description })}---\n\n${instructions.trimEnd()}\n`);
}

function readSkill(folder: string, file: SkillFile): { name: string; description: string } {
  const fail = (key: MessageKey, values?: MessageValues): never => {
    throw new PackageError(key, file.path, values);
  };
  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(file.content);
  } catch {
    fail("skills.package.notUtf8");
  }
  const parts = splitSkillMd(text) ?? fail("skills.package.noFrontmatter");
  let meta: unknown;
  try {
    meta = parse(parts.frontmatter);
  } catch {
    fail("skills.package.badYaml");
  }
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return fail("skills.package.notMapping");
  const { name, description } = meta as Record<string, unknown>;
  if (name !== folder) fail("skills.package.nameMismatch", { folder });
  if (typeof description !== "string" || description.trim() === "") return fail("skills.package.noDescription");
  if (description.length > MAX_DESCRIPTION || !storable(description)) fail("skills.package.descriptionLong", { max: MAX_DESCRIPTION });
  return { name: folder, description };
}

/**
 * Checks a skill package and lists its skills. Every top-level folder is one skill, with a
 * `SKILL.md` whose frontmatter names it; every path passes `isSafeRelativePath` and no two collide
 * (case ignored, as on macOS; nor is a file where another path needs a folder). At most 500 files,
 * 2 MiB per file and 8 MiB in all. Throws `PackageError`.
 */
export function validatePackage(files: SkillFile[]): { skills: { name: string; description: string }[] } {
  if (files.length === 0) throw new PackageError("skills.package.empty");
  if (files.length > MAX_FILES) throw new PackageError("skills.package.tooManyFiles", undefined, { max: MAX_FILES });
  const seen = new Set<string>();
  const folders = new Set<string>();
  const skillMds = new Map<string, SkillFile>();
  let total = 0;
  for (const file of files) {
    if (!isSafeRelativePath(file.path)) throw new PackageError("skills.package.unsafePath", file.path);
    const segments = file.path.split("/");
    if (segments.length < 2) throw new PackageError("skills.package.outsideFolder", file.path);
    if (!SKILL_NAME.test(segments[0]!)) {
      throw new PackageError("skills.package.badFolder", file.path);
    }
    const key = file.path.toLowerCase();
    if (seen.has(key) || folders.has(key)) throw new PackageError("skills.package.twice", file.path);
    seen.add(key);
    for (let i = 1; i < segments.length; i++) {
      const folder = segments.slice(0, i).join("/").toLowerCase();
      if (seen.has(folder)) throw new PackageError("skills.package.folderName", file.path);
      folders.add(folder);
    }
    if (file.content.byteLength > MAX_FILE_BYTES) throw new PackageError("skills.package.fileTooBig", file.path);
    total += file.content.byteLength;
    if (total > MAX_PACKAGE_BYTES) throw new PackageError("skills.package.tooBig");
    if (segments.length === 2 && segments[1] === "SKILL.md") skillMds.set(segments[0]!, file);
  }
  const names = [...new Set(files.map((f) => f.path.split("/")[0]!))].sort();
  return {
    skills: names.map((name) => {
      const md = skillMds.get(name);
      if (!md) throw new PackageError("skills.package.noSkillMd", `${name}/SKILL.md`);
      return readSkill(name, md);
    }),
  };
}
