import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { storable } from "@dispand/runner-protocol";
import { z } from "zod";

/** The marketplaces every owner starts with; they can't be removed. */
export const BUILT_IN_MARKETPLACES = [
  { name: "claude-plugins-official", url: "https://github.com/anthropics/claude-plugins-official.git" },
  { name: "anthropic-agent-skills", url: "https://github.com/anthropics/skills.git" },
] as const;

export type MarketplaceSource =
  | { type: "path"; path: string }
  | { type: "git"; url: string; ref?: string; sha?: string; path?: string }
  | { type: "unsupported"; reason: string }
  /** A skill site's index (`well-known.ts`): the source of a `well-known` marketplace's one entry. */
  | { type: "well-known"; url: string };

/**
 * What a marketplace row reads: a Git repository with a `.claude-plugin/marketplace.json`, a Git
 * repository of skills (`skills/<name>/SKILL.md`, no marketplace file: one entry), or a skill site's
 * `/.well-known/skills/index.json` (one entry).
 */
export type MarketplaceKind = "marketplace" | "skill-repo" | "well-known";

/** The parts of a manifest a `strict: false` entry carries itself (it is then the plugin's manifest). */
export type EntryManifest = { hooks?: unknown; commands?: unknown; agents?: unknown; mcpServers?: unknown };

export type MarketplaceEntry = {
  name: string;
  description?: string;
  version?: string;
  /** Skill folders, relative to the plugin's root. */
  skills?: string[];
  source: MarketplaceSource;
  manifest?: EntryManifest;
};

/** Marketplaces are read from a checkout capped in size; this caps the one file read whole. */
const MAX_MARKETPLACE_BYTES = 5 * 1024 * 1024;
const MAX_ENTRIES = 2000;

export class MarketplaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketplaceError";
  }
}

const Text = (max: number) => z.string().max(max).refine(storable);
const Optional = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

const Entry = z.object({
  name: Text(200).min(1),
  description: Optional(Text(2000)),
  version: Optional(Text(100)),
  skills: Optional(z.array(Text(500)).max(200)),
  source: z.unknown(),
  hooks: z.unknown().optional(),
  commands: z.unknown().optional(),
  agents: z.unknown().optional(),
  mcpServers: z.unknown().optional(),
});

const File = z.object({ name: Text(200).min(1), plugins: z.array(z.unknown()).max(MAX_ENTRIES) });

/** Whether every string in a JSON value, keys included, can be stored in JSONB. */
export function allStorable(value: unknown): boolean {
  if (typeof value === "string") return storable(value);
  if (Array.isArray(value)) return value.every(allStorable);
  if (typeof value === "object" && value !== null) return Object.entries(value).every(([k, v]) => storable(k) && allStorable(v));
  return true;
}

const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A `{ source, ... }` object's optional ref and sha, when they are strings. */
function pin(source: Record<string, unknown>): { ref?: string; sha?: string } {
  const out: { ref?: string; sha?: string } = {};
  if (typeof source.ref === "string" && storable(source.ref) && source.ref.length <= 200) out.ref = source.ref;
  if (typeof source.sha === "string" && /^[0-9a-f]{40}$/.test(source.sha)) out.sha = source.sha;
  return out;
}

/** A Git URL as written in a marketplace: a full URL, or GitHub's `owner/repo`. */
function gitUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2000 || !storable(value)) return null;
  if (GITHUB_REPO.test(value)) return `https://github.com/${value}.git`;
  return value;
}

/** Maps a marketplace entry's `source` to how Dispand fetches it. */
export function mapSource(source: unknown): MarketplaceSource {
  if (typeof source === "string") {
    if (source.length > 500 || !storable(source)) return { type: "unsupported", reason: "Its path is too long" };
    return { type: "path", path: source };
  }
  if (typeof source !== "object" || source === null || Array.isArray(source)) return { type: "unsupported", reason: "Its source isn't readable" };
  const s = source as Record<string, unknown>;
  const kind = s.source;
  if (kind === "github") {
    if (typeof s.repo !== "string" || !GITHUB_REPO.test(s.repo)) return { type: "unsupported", reason: "Its GitHub repository isn't owner/name" };
    return { type: "git", url: `https://github.com/${s.repo}.git`, ...pin(s) };
  }
  if (kind === "url" || kind === "git-subdir") {
    const url = gitUrl(s.url);
    if (!url) return { type: "unsupported", reason: "Its Git URL isn't readable" };
    const path = kind === "git-subdir" ? s.path : undefined;
    if (path !== undefined && (typeof path !== "string" || path.length > 500 || !storable(path))) {
      return { type: "unsupported", reason: "Its folder isn't readable" };
    }
    return { type: "git", url, ...pin(s), ...(path ? { path } : {}) };
  }
  const named = typeof kind === "string" && /^[a-z0-9-]{1,30}$/.test(kind) ? `“${kind}” sources` : "Its kind of source";
  return { type: "unsupported", reason: `${named} aren't supported: only Git repositories are` };
}

/**
 * Reads `.claude-plugin/marketplace.json` from a checkout. Unknown fields are ignored, and an
 * entry that doesn't parse (no name, a field of the wrong type) is left out rather than failing
 * the whole marketplace. Throws `MarketplaceError` when the file is missing or isn't one.
 */
export function parseMarketplace(dir: string): { name: string; entries: MarketplaceEntry[] } {
  const path = join(dir, ".claude-plugin", "marketplace.json");
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new MarketplaceError("This repository has no .claude-plugin/marketplace.json");
  }
  if (!stat.isFile()) throw new MarketplaceError(".claude-plugin/marketplace.json isn't a regular file");
  if (stat.size > MAX_MARKETPLACE_BYTES) throw new MarketplaceError(".claude-plugin/marketplace.json is larger than 5 MiB");
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new MarketplaceError(".claude-plugin/marketplace.json isn't valid JSON");
  }
  const file = File.safeParse(json);
  if (!file.success) throw new MarketplaceError(".claude-plugin/marketplace.json needs a name and a list of plugins");
  const entries: MarketplaceEntry[] = [];
  const names = new Set<string>();
  for (const raw of file.data.plugins) {
    const parsed = Entry.safeParse(raw);
    if (!parsed.success || names.has(parsed.data.name)) continue;
    names.add(parsed.data.name);
    const { name, description, version, skills, source, hooks, commands, agents, mcpServers } = parsed.data;
    const manifest: EntryManifest = {};
    if (hooks !== undefined) manifest.hooks = hooks;
    if (commands !== undefined) manifest.commands = commands;
    if (agents !== undefined) manifest.agents = agents;
    if (mcpServers !== undefined) manifest.mcpServers = mcpServers;
    // What is stored must fit JSONB: a manifest with a NUL or a lone surrogate is dropped.
    const storableManifest = Object.keys(manifest).length > 0 && allStorable(manifest) ? manifest : undefined;
    entries.push({
      name,
      ...(description !== undefined ? { description } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(skills !== undefined ? { skills } : {}),
      source: mapSource(source),
      ...(storableManifest ? { manifest: storableManifest } : {}),
    });
  }
  return { name: file.data.name, entries };
}
