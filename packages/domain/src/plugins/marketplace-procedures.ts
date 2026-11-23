import { lstatSync, realpathSync } from "node:fs";
import { requireLegacyWorkspace } from "../workspace/access.ts";
import { join, relative } from "node:path";
import { ORPCError } from "@orpc/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { type Db } from "../db/client.ts";
import { marketplaces as marketplacesTable, plugins as pluginsTable } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { external, message, say } from "../messages/index.ts";
import { SKILL_NAME } from "../skills/package.ts";
import { type Tx } from "../skills/procedures.ts";
import { readChangelog } from "./release-notes.ts";
import { fetchGit, GitError } from "./git.ts";
import { BUILT_IN_MARKETPLACES, MarketplaceError, type MarketplaceEntry, type MarketplaceKind, parseMarketplace } from "./marketplace.ts";
import { readWellKnownIndex, readWellKnownSkills, WellKnownError, wellKnownIndexUrl } from "./well-known.ts";
import { type PluginContents, readPlugin, resolvePluginRoot } from "./read-plugin.ts";
import { MAX_RUNNER_FILES, Notes, readRunnerFiles, withBudget, isDir } from "./fs.ts";
import { type PluginFile } from "./runner-servers.ts";
import { owner, asBadRequest, Id } from "./common.ts";

type MarketplaceRow = typeof marketplacesTable.$inferSelect;

/** Gives a new owner the built-in marketplaces, unsynced. */
export async function seedMarketplaces(tx: Tx, ownerId: string, workspaceId: string): Promise<void> {
  await tx.insert(marketplacesTable).values(BUILT_IN_MARKETPLACES.map((m) => ({ id: newId("mkt"), ownerId, workspaceId, name: m.name, url: m.url, builtIn: true })));
}

/** A Git repository of skills is named after its repository: `https://host/acme/skills.git` is `skills`. */
function repoName(url: string): string {
  const last = new URL(url).pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  return last.replace(/\.git$/, "").slice(0, 200) || new URL(url).hostname;
}

/**
 * Reads what a marketplace row lists. A skill site's index (`well-known`) is one entry; a Git
 * repository is a marketplace when it has `.claude-plugin/marketplace.json`, else a skill
 * repository (one entry, its `skills/` folder) when it has `skills/`.
 */
async function readSource(kind: "git" | "well-known", url: string, allowFile: boolean): Promise<{ kind: MarketplaceKind; name: string; entries: MarketplaceEntry[] }> {
  if (kind === "well-known") {
    const skills = await readWellKnownIndex(url);
    const host = new URL(url).hostname;
    // Only names a skill can have reach the stored description.
    const names = skills.map((s) => s.name).filter((n) => SKILL_NAME.test(n)).join(", ");
    const description = `${skills.length} ${skills.length === 1 ? "skill" : "skills"}: ${names}`;
    return { kind: "well-known", name: host, entries: [{ name: host, description: [...description].slice(0, 1000).join(""), source: { type: "well-known", url } }] };
  }
  const checkout = await fetchGit(url, { allowFile });
  try {
    const listed = lstatOrNull(join(checkout.dir, ".claude-plugin", "marketplace.json"));
    if (!listed && isDir(join(checkout.dir, "skills"))) {
      const name = repoName(url);
      return { kind: "skill-repo", name, entries: [{ name, description: `Skills from ${url}`, source: { type: "path", path: "." } }] };
    }
    if (!listed) throw new MarketplaceError("marketplaceFile.neither");
    return { kind: "marketplace", ...parseMarketplace(checkout.dir) };
  } finally {
    await checkout.cleanup();
  }
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Fetches an entry's plugin (from its own repository, or its marketplace's for a relative path) and reads it. */
export async function readEntry(market: MarketplaceRow, entry: MarketplaceEntry, allowFile: boolean): Promise<{ contents: PluginContents; files?: PluginFile[]; url: string; sha: string; nativeRoot?: string; changelog?: string | null }> {
  const { source } = entry;
  if (source.type === "unsupported") {
    if (typeof source.reason === "string") throw new ORPCError("BAD_REQUEST", external(source.reason));
    throw new ORPCError("BAD_REQUEST", message(source.reason.key, source.reason.values));
  }
  if (source.type === "well-known") return { ...(await readWellKnownSkills(source.url)), url: source.url };
  const url = source.type === "git" ? source.url : market.url;
  const checkout = await fetchGit(url, source.type === "git" ? { ref: source.ref, sha: source.sha, allowFile } : { allowFile });
  try {
    const root = resolvePluginRoot(checkout.dir, source.path);
    // The repository's links under the plugin, as paths from its root.
    const prefix = relative(realpathSync(checkout.dir), root);
    const links = checkout.links.flatMap((l) => (prefix === "" ? [l] : l.startsWith(`${prefix}/`) ? [l.slice(prefix.length + 1)] : []));
    const contents = readPlugin(root, entry, links);
    // A standard plugin's stdio servers run its own files on a runner: Dispand keeps them to send.
    const stdio = contents.layout === "standard" ? contents.mcpServers.filter((s) => s.type === "stdio") : [];
    const notes = new Notes();
    const files = stdio.length ? withBudget(() => readRunnerFiles(root, notes)) : undefined;
    // Too large for a runner: the plugin installs all the same, keeping none (adding such a server is refused, `noFiles`).
    if (files === null) for (const s of stdio) notes.push({ component: "mcp-server", name: s.name, reason: say("notImported.runnerTooLarge", { max: MAX_RUNNER_FILES }) });
    const read = { ...contents, notImported: [...contents.notImported, ...notes.list()] };
    return { contents: read, ...(files ? { files } : {}), url, sha: checkout.sha, nativeRoot: prefix || ".", changelog: readChangelog(root) };
  } finally {
    await checkout.cleanup();
  }
}

/** A package name (`SKILL_NAME`) for a plugin's skills, from the plugin's name. */
export function packageName(plugin: string): string {
  const slug = plugin
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return slug || "plugin";
}

const Url = z.string().trim().min(1).max(2000);

export const EntryRef = z.object({ marketplaceId: z.string().max(64), entryName: z.string().max(200) });

export async function findMarketplace(db: Db | Tx, ownerId: string, id: string): Promise<MarketplaceRow> {
  const [row] = await db
    .select()
    .from(marketplacesTable)
    .where(and(eq(marketplacesTable.id, id), eq(marketplacesTable.ownerId, ownerId)));
  if (!row) throw new ORPCError("NOT_FOUND", message("plugins.marketplace.notFound"));
  return row;
}

export function findEntry(market: MarketplaceRow, entryName: string): MarketplaceEntry {
  const entry = market.entries.find((e) => e.name === entryName);
  if (!entry) throw new ORPCError("NOT_FOUND", message("plugins.marketplace.noPlugin", { marketplace: market.name, plugin: entryName }));
  return entry;
}

function marketplaceView(row: MarketplaceRow) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    kind: row.kind,
    builtIn: row.builtIn,
    plugins: row.entries.length,
    syncedAt: row.syncedAt,
    syncError: row.syncError,
  };
}

/** Reads a marketplace again: new entries on success; on failure the previous ones stay and the reason is stored. */
export async function syncMarketplace(db: Db, row: MarketplaceRow, allowFile: boolean): Promise<MarketplaceRow> {
  let set: Partial<MarketplaceRow>;
  try {
    const { kind, name, entries } = await readSource(row.kind === "well-known" ? "well-known" : "git", row.url, allowFile);
    set = { kind, name, entries, syncedAt: new Date(), syncError: null };
  } catch (e) {
    if (!(e instanceof GitError || e instanceof MarketplaceError || e instanceof WellKnownError)) throw e;
    set = { syncError: e.stored };
  }
  const [updated] = await db.update(marketplacesTable).set(set).where(eq(marketplacesTable.id, row.id)).returning();
  return updated ?? row;
}

const listMarketplaces = owner.handler(async ({ context }) => {
  const rows = await context.db
    .select()
    .from(marketplacesTable)
    .where(eq(marketplacesTable.ownerId, context.ownerId))
    .orderBy(desc(marketplacesTable.builtIn), asc(marketplacesTable.name));
  return rows.map(marketplaceView);
});

/** A marketplace as the owner types it: a Git URL, or GitHub's `owner/repo`. */
export function marketplaceUrl(input: string): string {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input) ? `https://github.com/${input.replace(/\.git$/, "")}.git` : input;
}

const AddInput = z.object({ url: Url, kind: z.enum(["git", "well-known"]).default("git") });

const addMarketplace = owner.input(AddInput).handler(async ({ input, context }) => {
  let url: string;
  try {
    url = input.kind === "well-known" ? wellKnownIndexUrl(input.url) : marketplaceUrl(input.url);
  } catch (e) {
    return asBadRequest(e);
  }
  const { kind, name, entries } = await readSource(input.kind, url, !!context.gitFileUrls).catch(asBadRequest);
  const id = newId("mkt");
  try {
    await context.db.insert(marketplacesTable).values({ id, ownerId: context.ownerId, workspaceId: await requireLegacyWorkspace(context), name, url, kind, entries, syncedAt: new Date() });
  } catch (err) {
    const e = err as { code?: unknown; cause?: { code?: unknown } };
    if (e.code === "23505" || e.cause?.code === "23505") throw new ORPCError("CONFLICT", message("plugins.marketplace.duplicate"));
    throw err;
  }
  return marketplaceView(await findMarketplace(context.db, context.ownerId, id));
});

const removeMarketplace = owner.input(Id).handler(async ({ input, context }) => {
  await context.db.transaction(async (tx) => {
    const row = await findMarketplace(tx, context.ownerId, input.id);
    if (row.builtIn) throw new ORPCError("FORBIDDEN", message("plugins.marketplace.builtIn"));
    const installed = await tx.select({ name: pluginsTable.name }).from(pluginsTable).where(eq(pluginsTable.marketplaceId, row.id));
    if (installed.length > 0) {
      throw new ORPCError("CONFLICT", message("plugins.marketplace.removeFirst", { plugins: installed.map((p) => p.name) }));
    }
    await tx.delete(marketplacesTable).where(eq(marketplacesTable.id, row.id));
  });
});

export const sync = owner.input(Id).handler(async ({ input, context }) => {
  const row = await findMarketplace(context.db, context.ownerId, input.id);
  return marketplaceView(await syncMarketplace(context.db, row, !!context.gitFileUrls));
});

/** An entry as Discover shows it: without the manifest parts a `strict: false` entry carries. */
function entryView(entry: MarketplaceEntry) {
  return {
    name: entry.name,
    description: entry.description ?? "",
    version: entry.version ?? null,
    source: entry.source.type === "unsupported" ? { supported: false as const, reason: typeof entry.source.reason === "string" ? { text: entry.source.reason } : entry.source.reason } : { supported: true as const },
  };
}

export const discover = owner.input(z.object({ query: z.string().max(200).optional() })).handler(async ({ input, context }) => {
  const markets = await context.db
    .select()
    .from(marketplacesTable)
    .where(eq(marketplacesTable.ownerId, context.ownerId))
    .orderBy(asc(marketplacesTable.createdAt), asc(marketplacesTable.name));
  const installed = new Set(
    (await context.db.select().from(pluginsTable).where(eq(pluginsTable.ownerId, context.ownerId))).map((p) => `${p.marketplaceId}\n${p.entryName}`),
  );
  const query = input.query?.trim().toLowerCase() ?? "";
  return markets.flatMap((m) =>
    m.entries
      .filter((e) => !query || e.name.toLowerCase().includes(query) || (e.description ?? "").toLowerCase().includes(query))
      .map((e) => ({ marketplaceId: m.id, marketplace: m.name, entry: entryView(e), installed: installed.has(`${m.id}\n${e.name}`) })),
  );
});

export const marketplaces = { list: listMarketplaces, add: addMarketplace, remove: removeMarketplace, sync };
