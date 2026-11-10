import { createHash } from "node:crypto";
import { isSafeRelativePath, storable } from "@dispand/runner-protocol";
import { z } from "zod";
import { MAX_DESCRIPTION, MAX_FILES, MAX_FILE_BYTES, PackageError, SKILL_NAME, type SkillFile, validatePackage } from "../skills/package.ts";
import type { NotImported, PluginContents } from "./read-plugin.ts";

/**
 * Skill sites: `https://<site>/.well-known/skills/index.json` lists skills (`{ skills: [{ name,
 * description, files }] }`) whose files are at `/.well-known/skills/<name>/<file>` (the Agent
 * Skills discovery convention, served by mastra.ai for one).
 */
export class WellKnownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WellKnownError";
  }
}

const INDEX_PATH = "/.well-known/skills/index.json";
const MAX_INDEX_BYTES = 1024 * 1024;
const MAX_SKILLS = 200;
/** Everything one read downloads, at most, and how long it may take. */
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 3;

/** The index URL of a skill site: a site (`https://example.com`) or its index itself. Throws `WellKnownError`. */
export function wellKnownIndexUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new WellKnownError("Use an https:// address");
  }
  if (url.protocol !== "https:" || url.hostname === "") throw new WellKnownError("Use an https:// address");
  if (url.username !== "" || url.password !== "") throw new WellKnownError("An address can't hold credentials");
  if (url.pathname.endsWith(INDEX_PATH)) return `${url.origin}${url.pathname}`;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}${INDEX_PATH}`;
}

type Budget = { bytes: number; signal: AbortSignal };

/**
 * GETs `url` and returns its body, at most `max` bytes (and within the read's budget). Redirects
 * are followed only to the same origin (at most 3); any other is refused, as is a non-200 answer.
 */
async function get(url: string, max: number, budget: Budget): Promise<{ bytes: Uint8Array; url: string }> {
  const origin = new URL(url).origin;
  let current = url;
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetch(current, { redirect: "manual", signal: budget.signal });
    } catch {
      throw new WellKnownError(budget.signal.aborted ? `${origin} took longer than ${TIMEOUT_MS / 1000} s` : `Couldn't reach ${origin}`);
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      const location = res.headers.get("location");
      const next = location ? new URL(location, current) : null;
      if (!next || next.origin !== origin || hop >= MAX_REDIRECTS) throw new WellKnownError(`${origin} redirected the request elsewhere`);
      current = next.href;
      continue;
    }
    if (res.status !== 200 || !res.body) {
      await res.body?.cancel();
      throw new WellKnownError(`${origin} answered ${res.status} for ${new URL(current).pathname}`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const chunk of res.body) {
        size += chunk.byteLength;
        budget.bytes += chunk.byteLength;
        if (size > max || budget.bytes > MAX_TOTAL_BYTES) {
          await res.body.cancel().catch(() => undefined);
          throw new WellKnownError(`${new URL(current).pathname} on ${origin} is too large`);
        }
        chunks.push(chunk);
      }
    } catch (e) {
      if (e instanceof WellKnownError) throw e;
      throw new WellKnownError(budget.signal.aborted ? `${origin} took longer than ${TIMEOUT_MS / 1000} s` : `${origin} cut the connection`);
    }
    return { bytes: Buffer.concat(chunks), url: current };
  }
}

const Index = z.object({
  skills: z
    .array(
      z.object({
        name: z.string().max(64),
        description: z.string().max(MAX_DESCRIPTION).refine(storable).optional(),
        files: z.array(z.string().max(255)).max(MAX_FILES),
      }),
    )
    .max(MAX_SKILLS),
});
export type WellKnownSkill = z.infer<typeof Index>["skills"][number];

function newBudget(): Budget {
  return { bytes: 0, signal: AbortSignal.timeout(TIMEOUT_MS) };
}

/** The index's skills, and where it really was (after same-origin redirects): files are relative to that. */
async function index(indexUrl: string, budget: Budget): Promise<{ skills: WellKnownSkill[]; url: string }> {
  const { bytes, url } = await get(indexUrl, MAX_INDEX_BYTES, budget);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new WellKnownError("The site's skills index isn't valid JSON");
  }
  const parsed = Index.safeParse(json);
  if (!parsed.success) throw new WellKnownError(`The site's skills index isn't { skills: [{ name, description, files }] } (at most ${MAX_SKILLS} skills)`);
  return { skills: parsed.data.skills, url };
}

/** The skills a site's index lists (fetched over https, nothing else). Throws `WellKnownError`. */
export async function readWellKnownIndex(indexUrl: string): Promise<WellKnownSkill[]> {
  return (await index(wellKnownIndexUrl(indexUrl), newBudget())).skills;
}

/**
 * Downloads every skill of a site and checks each as a package of its own (`validatePackage`,
 * so every path passes `isSafeRelativePath`); a skill that fails is listed as not imported with
 * its reason. `sha` is a SHA-256 of the files, so an update can tell whether anything changed.
 */
export async function readWellKnownSkills(indexUrl: string): Promise<{ contents: PluginContents; sha: string }> {
  const budget = newBudget();
  const { skills: listed, url } = await index(wellKnownIndexUrl(indexUrl), budget);
  const base = new URL(".", url).href;
  const skills: PluginContents["skills"] = [];
  const notImported: NotImported[] = [];
  const seen = new Set<string>();
  for (const skill of listed) {
    if (!SKILL_NAME.test(skill.name) || seen.has(skill.name)) {
      notImported.push({ component: "skill", name: storable(skill.name) ? skill.name : "?", reason: "Its name isn't lowercase letters, digits and hyphens, or is listed twice" });
      continue;
    }
    seen.add(skill.name);
    const unsafe = skill.files.find((f) => !isSafeRelativePath(`${skill.name}/${f}`));
    if (unsafe !== undefined) {
      notImported.push({ component: "skill", name: skill.name, reason: "One of its files has a path a skill can't hold" });
      continue;
    }
    const files: SkillFile[] = [];
    for (const path of new Set(skill.files)) {
      const fileUrl = new URL(`${skill.name}/${path.split("/").map(encodeURIComponent).join("/")}`, base);
      if (fileUrl.origin !== new URL(base).origin) throw new WellKnownError("A skill file points to another site");
      files.push({ path: `${skill.name}/${path}`, content: (await get(fileUrl.href, MAX_FILE_BYTES, budget)).bytes });
    }
    try {
      const [checked] = validatePackage(files).skills;
      skills.push({ name: skill.name, description: checked!.description, files });
    } catch (e) {
      if (!(e instanceof PackageError)) throw e;
      notImported.push({ component: "skill", name: skill.name, reason: e.message });
    }
  }
  const hash = createHash("sha256");
  for (const s of skills) for (const f of s.files) hash.update(`${f.path}\0${f.content.byteLength}\0`).update(f.content);
  return { contents: { skills, mcpServers: [], agents: [], notImported }, sha: hash.digest("hex").slice(0, 40) };
}
