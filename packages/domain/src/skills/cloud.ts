import { isSafeRelativePath, TEXT } from "@dispand/runner-protocol";
import { and, asc, eq, inArray, like } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { skillFiles, skillPackages, skills as skillsTable } from "../db/schema.ts";
import { storableText } from "../cloud/builtins.ts";
import { sessionTooling } from "../engine/tooling.ts";
import { meter, tracer } from "../telemetry/index.ts";

// A cloud session's skills, the way Agent Skills work: each skill's name and description in the
// system prompt, and `read_skill` to read its files on demand (`SKILL.md` first). Only the skills
// of the session's agent (for a Job, those of its snapshot the agent still has: `sessionTooling`),
// read again at every turn and every call. A file is found by its exact stored path inside the
// skill's folder: nothing is decoded or normalized, and there is no filesystem behind it.

const traces = tracer("skills");
const counts = meter("skills");

/** A skill the session may read. `id` is its name, or `<package>:<name>` when two of its packages have a skill of that name. */
export type CloudSkill = { id: string; packageId: string; name: string; description: string };

export async function sessionSkills(db: Db, sessionId: string): Promise<CloudSkill[]> {
  const { skills: packages } = await sessionTooling(db, sessionId);
  if (packages.length === 0) return [];
  const rows = await db
    .select({ packageId: skillsTable.packageId, packageName: skillPackages.name, name: skillsTable.name, description: skillsTable.description })
    .from(skillsTable)
    .innerJoin(skillPackages, eq(skillPackages.id, skillsTable.packageId))
    .where(
      inArray(
        skillsTable.packageId,
        packages.map((p) => p.packageId),
      ),
    )
    .orderBy(asc(skillsTable.name), asc(skillPackages.name));
  const twice = new Set(rows.filter((r, i) => rows.findIndex((o) => o.name === r.name) !== i).map((r) => r.name));
  return rows.map((r) => ({ id: twice.has(r.name) ? `${r.packageName}:${r.name}` : r.name, packageId: r.packageId, name: r.name, description: r.description }));
}

/** The skills, for the system prompt; empty when there are none. */
export function skillsPrompt(skills: CloudSkill[]): string {
  if (skills.length === 0) return "";
  return [
    "You have skills: instructions and references for particular tasks. When a task matches a skill's description, read its SKILL.md with read_skill before you start, then the files it points to as you need them.",
    "Skills (name: when to use it):",
    ...skills.map((s) => `- ${s.id}: ${s.description.replaceAll("\n", " ")}`),
  ].join("\n");
}

type Read = { text: string; isError: boolean };
const NOT_FOUND = (skill: string, path: string, files: string[]): Read => ({
  text: `${skill} has no file ${path}. Its files: ${files.join(", ")}`,
  isError: true,
});

/**
 * `read_skill` arguments to the file's text, or why not. The skill must be one `sessionSkills`
 * lists now, and the path one of its stored files, exactly: `..`, an absolute path or any other
 * unsafe path is refused before anything is looked up.
 */
export function readSkill(db: Db, sessionId: string, args: unknown): Promise<Read> {
  // In a span with how it ended; never the skill's name, the path or the text.
  return traces.startActiveSpan("skill.read", async (span) => {
    const read = await readFile(db, sessionId, args);
    span.setAttribute("dispand.result", read.result);
    span.end();
    counts.counter("dispand.skill.reads").add(1, { "dispand.result": read.result });
    return read;
  });
}

async function readFile(db: Db, sessionId: string, args: unknown): Promise<Read & { result: string }> {
  const refused = (text: string) => ({ text, isError: true, result: "refused" });
  const { skill, path } = (args ?? {}) as { skill?: unknown; path?: unknown };
  if (typeof skill !== "string" || typeof path !== "string") return refused("read_skill needs a skill (its name, as listed) and a path inside it (SKILL.md first).");
  if (!isSafeRelativePath(path)) return refused("The path must be relative to the skill's folder, without .. or . parts: SKILL.md, or a file it names.");
  const found = (await sessionSkills(db, sessionId)).find((s) => s.id === skill);
  if (!found) return refused(`There is no skill ${skill} among yours.`);
  const folder = `${found.name}/`;
  const [file] = await db
    .select({ content: skillFiles.content })
    .from(skillFiles)
    .where(and(eq(skillFiles.packageId, found.packageId), eq(skillFiles.path, `${folder}${path}`)));
  if (!file) {
    // The skill's files, so the model can correct the path; `LIKE` needs no escaping: a skill's name holds only letters, digits and hyphens.
    const all = await db
      .select({ path: skillFiles.path })
      .from(skillFiles)
      .where(and(eq(skillFiles.packageId, found.packageId), like(skillFiles.path, `${folder}%`)))
      .orderBy(asc(skillFiles.path));
    return { ...NOT_FOUND(skill, path, all.map((f) => f.path.slice(folder.length))), result: "not-found" };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(file.content);
  } catch {
    return refused(`${path} isn't text: it can't be read here.`);
  }
  // Kept in the session's items: no NUL, and no more than a result may hold.
  const cut = text.length > TEXT ? `${text.slice(0, TEXT)}\n\n[Cut: the file is longer than ${TEXT} characters.]` : text;
  return { text: storableText(cut), isError: false, result: "ok" };
}
