import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { ORPCError } from "@orpc/server";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import {
  agents as agentsTable,
  agentSkills,
  agentTools,
  harnesses,
  marketplaces as marketplacesTable,
  plugins as pluginsTable,
  skillPackages,
  skills as skillsTable,
  tools as toolsTable,
} from "../db/schema.ts";
import { newId } from "../ids.ts";
import { authed, base } from "../rpc/context.ts";
import { MAX_DESCRIPTION, PackageError, SKILL_NAME, validatePackage } from "../skills/package.ts";
import { store, type Tx } from "../skills/procedures.ts";
import { HeaderValue, insertTool, refreshActions, retarget } from "../tools/procedures.ts";
import { lockAgentsForDelete } from "../jobs/active.ts";
import { agentInUse } from "../workflows/procedures.ts";
import { agentName, hasPlaceholder, httpTool, pluginHolder, toolName } from "./components.ts";
import { fetchGit, GitError } from "./git.ts";
import { BUILT_IN_MARKETPLACES, MarketplaceError, type MarketplaceEntry, type MarketplaceKind, parseMarketplace } from "./marketplace.ts";
import { readWellKnownIndex, readWellKnownSkills, WellKnownError, wellKnownIndexUrl } from "./well-known.ts";
import { componentsOf, PluginError, type PluginContents, readPlugin, resolvePluginRoot } from "./read-plugin.ts";

const owner = base.use(authed);

type MarketplaceRow = typeof marketplacesTable.$inferSelect;

/** Gives a new owner the built-in marketplaces, unsynced. */
export async function seedMarketplaces(tx: Tx, ownerId: string): Promise<void> {
  await tx.insert(marketplacesTable).values(BUILT_IN_MARKETPLACES.map((m) => ({ id: newId("mkt"), ownerId, name: m.name, url: m.url, builtIn: true })));
}

/** A failure the owner can act on (a fetch, a marketplace or a plugin that isn't readable): BAD_REQUEST with its words. */
function asBadRequest(e: unknown): never {
  if (e instanceof GitError || e instanceof MarketplaceError || e instanceof PluginError || e instanceof PackageError || e instanceof WellKnownError) {
    throw new ORPCError("BAD_REQUEST", { message: e.message });
  }
  throw e;
}

/** A Git repository of skills is named after its repository: `https://host/acme/skills.git` is `skills`. */
function repoName(url: string): string {
  const last = new URL(url).pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  return last.replace(/\.git$/, "").slice(0, 200) || new URL(url).hostname;
}

function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
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
    if (!listed) throw new MarketplaceError("This repository has neither a .claude-plugin/marketplace.json nor a skills/ folder");
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
async function readEntry(market: MarketplaceRow, entry: MarketplaceEntry, allowFile: boolean): Promise<{ contents: PluginContents; url: string; sha: string }> {
  const { source } = entry;
  if (source.type === "unsupported") throw new ORPCError("BAD_REQUEST", { message: source.reason });
  if (source.type === "well-known") return { ...(await readWellKnownSkills(source.url)), url: source.url };
  const url = source.type === "git" ? source.url : market.url;
  const checkout = await fetchGit(url, source.type === "git" ? { ref: source.ref, sha: source.sha, allowFile } : { allowFile });
  try {
    const root = resolvePluginRoot(checkout.dir, source.path);
    // The repository's links under the plugin, as paths from its root.
    const prefix = relative(realpathSync(checkout.dir), root);
    const links = checkout.links.flatMap((l) => (prefix === "" ? [l] : l.startsWith(`${prefix}/`) ? [l.slice(prefix.length + 1)] : []));
    return { contents: readPlugin(root, entry, links), url, sha: checkout.sha };
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
const Id = z.object({ id: z.string().max(64) });
const EntryRef = z.object({ marketplaceId: z.string().max(64), entryName: z.string().max(200) });

async function findMarketplace(db: Db | Tx, ownerId: string, id: string): Promise<MarketplaceRow> {
  const [row] = await db
    .select()
    .from(marketplacesTable)
    .where(and(eq(marketplacesTable.id, id), eq(marketplacesTable.ownerId, ownerId)));
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Marketplace not found" });
  return row;
}

function findEntry(market: MarketplaceRow, entryName: string): MarketplaceEntry {
  const entry = market.entries.find((e) => e.name === entryName);
  if (!entry) throw new ORPCError("NOT_FOUND", { message: `${market.name} doesn't list a plugin called “${entryName}”` });
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
async function syncMarketplace(db: Db, row: MarketplaceRow, allowFile: boolean): Promise<MarketplaceRow> {
  let set: Partial<MarketplaceRow>;
  try {
    const { kind, name, entries } = await readSource(row.kind === "well-known" ? "well-known" : "git", row.url, allowFile);
    set = { kind, name, entries, syncedAt: new Date(), syncError: null };
  } catch (e) {
    if (!(e instanceof GitError || e instanceof MarketplaceError || e instanceof WellKnownError)) throw e;
    set = { syncError: e.message };
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
    await context.db.insert(marketplacesTable).values({ id, ownerId: context.ownerId, name, url, kind, entries, syncedAt: new Date() });
  } catch (err) {
    const e = err as { code?: unknown; cause?: { code?: unknown } };
    if (e.code === "23505" || e.cause?.code === "23505") throw new ORPCError("CONFLICT", { message: "This marketplace is already added" });
    throw err;
  }
  return marketplaceView(await findMarketplace(context.db, context.ownerId, id));
});

const removeMarketplace = owner.input(Id).handler(async ({ input, context }) => {
  await context.db.transaction(async (tx) => {
    const row = await findMarketplace(tx, context.ownerId, input.id);
    if (row.builtIn) throw new ORPCError("FORBIDDEN", { message: "Built-in marketplaces can't be removed" });
    const installed = await tx.select({ name: pluginsTable.name }).from(pluginsTable).where(eq(pluginsTable.marketplaceId, row.id));
    if (installed.length > 0) {
      throw new ORPCError("CONFLICT", { message: `Remove its plugins first: ${installed.map((p) => p.name).join(", ")}` });
    }
    await tx.delete(marketplacesTable).where(eq(marketplacesTable.id, row.id));
  });
});

const sync = owner.input(Id).handler(async ({ input, context }) => {
  const row = await findMarketplace(context.db, context.ownerId, input.id);
  return marketplaceView(await syncMarketplace(context.db, row, !!context.gitFileUrls));
});

/** An entry as Discover shows it: without the manifest parts a `strict: false` entry carries. */
function entryView(entry: MarketplaceEntry) {
  return {
    name: entry.name,
    description: entry.description ?? "",
    version: entry.version ?? null,
    source: entry.source.type === "unsupported" ? { supported: false as const, reason: entry.source.reason } : { supported: true as const },
  };
}

const discover = owner.input(z.object({ query: z.string().max(200).optional() })).handler(async ({ input, context }) => {
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

/**
 * What the owner reviewed of a plugin's MCP servers: their definitions as read (the marketplace's
 * manifest merged in) at that commit. An install of servers must match it.
 */
function reviewToken(sha: string, contents: PluginContents): string {
  return createHash("sha256").update(JSON.stringify([sha, contents.mcpServers])).digest("hex");
}

const preview = owner.input(EntryRef).handler(async ({ input, context }) => {
  const market = await findMarketplace(context.db, context.ownerId, input.marketplaceId);
  const { contents, sha } = await readEntry(market, findEntry(market, input.entryName), !!context.gitFileUrls).catch(asBadRequest);
  return { ...componentsOf(contents), notImported: contents.notImported, reviewed: reviewToken(sha, contents) };
});

/** The chosen skills' files, checked as one package (its caps); BAD_REQUEST for a name the plugin doesn't have. */
function chosenSkills(contents: PluginContents, names: string[]) {
  const chosen = names.map((name) => {
    const skill = contents.skills.find((s) => s.name === name);
    if (!skill) throw new ORPCError("BAD_REQUEST", { message: `The plugin has no skill “${name}” to import` });
    return skill;
  });
  const files = chosen.flatMap((s) => s.files);
  try {
    return { files, skills: validatePackage(files).skills };
  } catch (e) {
    return asBadRequest(e);
  }
}

/** The unique constraint a write broke ("" when the driver doesn't name it), or null for any other error. */
function uniqueConstraint(err: unknown): string | null {
  const e = err as { code?: unknown; constraint?: unknown; cause?: { code?: unknown; constraint?: unknown } };
  if ((e.code ?? e.cause?.code) !== "23505") return null;
  const name = e.constraint ?? e.cause?.constraint;
  return typeof name === "string" ? name : "";
}

/** One MCP server's settings: `${VAR}` name → value. */
const ServerSettings = z.record(z.string().max(100), HeaderValue).refine((s) => Object.keys(s).length <= 50, "At most 50 settings per MCP server");

const InstallInput = EntryRef.extend({
  skills: z.array(z.string().max(64)).max(200).default([]),
  mcpServers: z.array(z.string().max(100)).max(100).default([]),
  agents: z.array(z.string().max(100)).max(100).default([]),
  /** The harness the plugin's agents run on; required when `agents` isn't empty. */
  harnessId: z.string().max(64).optional(),
  /** `preview`'s `reviewed`; required to import MCP servers, so settings only go to URLs the owner saw. */
  reviewed: z.string().max(64).optional(),
  /** MCP server name → its settings. */
  settings: z
    .record(z.string().max(100), ServerSettings)
    .refine((s) => Object.keys(s).length <= 100, "At most 100 MCP servers")
    .default({}),
});

const unique = (names: string[]) => [...new Set(names)];

/**
 * Installs the components the owner ticked: skills as one read-only package, HTTP MCP servers as
 * HTTP tools (settings sealed), agents on the chosen harness with the plugin's imported skills and
 * tools. Everything is stored in one transaction; the tools' actions are listed afterwards.
 */
const install = owner
  .input(InstallInput)
  .handler(async ({ input, context }) => {
    const picked = { skills: unique(input.skills), mcpServers: unique(input.mcpServers), agents: unique(input.agents) };
    if (!picked.skills.length && !picked.mcpServers.length && !picked.agents.length) {
      throw new ORPCError("BAD_REQUEST", { message: "Pick at least one skill, MCP server or agent" });
    }
    const { harnessId } = input;
    if (picked.agents.length && !harnessId) throw new ORPCError("BAD_REQUEST", { message: "Pick the harness the plugin's agents run on" });
    if (picked.agents.length && harnessId) {
      const [harness] = await context.db
        .select({ id: harnesses.id })
        .from(harnesses)
        .where(and(eq(harnesses.id, harnessId), eq(harnesses.ownerId, context.ownerId)));
      if (!harness) throw new ORPCError("NOT_FOUND", { message: "Harness not found" });
    }
    const market = await findMarketplace(context.db, context.ownerId, input.marketplaceId);
    const entry = findEntry(market, input.entryName);
    const { contents, url, sha } = await readEntry(market, entry, !!context.gitFileUrls).catch(asBadRequest);
    if (picked.mcpServers.length && reviewToken(sha, contents) !== input.reviewed) {
      throw new ORPCError("CONFLICT", { message: `${entry.name} changed since you reviewed it: look at it again before installing` });
    }
    const chosen = picked.skills.length ? chosenSkills(contents, picked.skills) : null;
    const pluginId = newId("plugin");
    const servers = picked.mcpServers.map((serverName) => {
      const server = contents.mcpServers.find((s) => s.name === serverName);
      if (!server) throw new ORPCError("BAD_REQUEST", { message: `The plugin has no MCP server “${serverName}” to import` });
      // Runner tools (stdio servers) come with the runner's MCP servers.
      if (server.type !== "http") throw new ORPCError("BAD_REQUEST", { message: `The MCP server ${serverName} runs a command on a machine: not yet supported` });
      return { name: server.name, fields: httpTool(server, input.settings[server.name] ?? {}, pluginId) };
    });
    const agents = picked.agents.map((agentName) => {
      const agent = contents.agents.find((a) => a.name === agentName);
      if (!agent) throw new ORPCError("BAD_REQUEST", { message: `The plugin has no agent “${agentName}” to import` });
      return agent;
    });
    const name = packageName(entry.name);
    const description = (entry.description ?? "").slice(0, MAX_DESCRIPTION);
    let created: { tools: (typeof toolsTable.$inferSelect)[]; agentIds: string[] };
    try {
      created = await context.db.transaction(async (tx) => {
        await tx.insert(pluginsTable).values({
          id: pluginId,
          ownerId: context.ownerId,
          name: entry.name,
          description,
          marketplaceId: market.id,
          entryName: entry.name,
          url,
          sha,
          components: componentsOf(contents),
          notImported: contents.notImported,
        });
        const packageId = chosen ? newId("skillpkg") : null;
        if (chosen && packageId) {
          await tx.insert(skillPackages).values({ id: packageId, ownerId: context.ownerId, name, description, pluginId });
          await store(tx, packageId, chosen.files, chosen.skills);
        }
        const tools = [];
        for (const server of servers) {
          const toolNameFree = await toolName(tx, context.ownerId, server.name, entry.name);
          tools.push(await insertTool(tx, context.secrets, context.ownerId, { ...server.fields, name: toolNameFree }));
        }
        const agentIds: string[] = [];
        for (const agent of agents) {
          const id = newId("agent");
          const named = await agentName(tx, context.ownerId, agent.name, entry.name);
          // The agent file's `tools` and `model` aren't read: the harness decides them.
          await tx.insert(agentsTable).values({
            id,
            ownerId: context.ownerId,
            name: named,
            harnessId: harnessId!,
            systemPrompt: agent.systemPrompt,
            pluginId,
            pluginComponent: agent.name,
          });
          if (packageId) await tx.insert(agentSkills).values({ agentId: id, packageId });
          if (tools.length) await tx.insert(agentTools).values(tools.map((t) => ({ agentId: id, toolId: t.id })));
          agentIds.push(id);
        }
        return { tools, agentIds };
      });
    } catch (err) {
      const broken = uniqueConstraint(err);
      if (broken === "skill_packages_owner_name") throw new ORPCError("CONFLICT", { message: `A skill is already called “${name}”` });
      if (broken !== null) throw new ORPCError("CONFLICT", { message: `${entry.name} is already installed` });
      throw err;
    }
    for (const tool of created.tools) await refreshActions(context.db, context.secrets, context.tools, tool);
    return { pluginId, toolIds: created.tools.map((t) => t.id), agentIds: created.agentIds };
  });

type PluginRow = typeof pluginsTable.$inferSelect;

async function findPlugin(db: Db | Tx, ownerId: string, id: string, lock = false): Promise<PluginRow> {
  const query = db
    .select()
    .from(pluginsTable)
    .where(and(eq(pluginsTable.id, id), eq(pluginsTable.ownerId, ownerId)));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Plugin not found" });
  return row;
}

const list = owner.handler(async ({ context }) => {
  const rows = await context.db.select().from(pluginsTable).where(eq(pluginsTable.ownerId, context.ownerId)).orderBy(asc(pluginsTable.name));
  const ids = rows.map((r) => r.id);
  const packages = ids.length ? await context.db.select().from(skillPackages).where(inArray(skillPackages.pluginId, ids)) : [];
  const skillRows = packages.length
    ? await context.db
        .select()
        .from(skillsTable)
        .where(
          inArray(
            skillsTable.packageId,
            packages.map((p) => p.id),
          ),
        )
        .orderBy(asc(skillsTable.name))
    : [];
  const markets = await context.db.select().from(marketplacesTable).where(eq(marketplacesTable.ownerId, context.ownerId));
  const toolRows = ids.length
    ? await context.db
        .select({ id: toolsTable.id, name: toolsTable.name, pluginId: toolsTable.pluginId, component: toolsTable.pluginComponent })
        .from(toolsTable)
        .where(inArray(toolsTable.pluginId, ids))
        .orderBy(asc(toolsTable.name))
    : [];
  const agentRows = ids.length
    ? await context.db
        .select({ id: agentsTable.id, name: agentsTable.name, pluginId: agentsTable.pluginId, component: agentsTable.pluginComponent })
        .from(agentsTable)
        .where(inArray(agentsTable.pluginId, ids))
        .orderBy(asc(agentsTable.name))
    : [];
  return rows.map((r) => {
    const pkg = packages.find((p) => p.pluginId === r.id);
    const imported = skillRows.filter((s) => s.packageId === pkg?.id).map((s) => ({ name: s.name, description: s.description }));
    const tools = toolRows.filter((t) => t.pluginId === r.id);
    const agents = agentRows.filter((a) => a.pluginId === r.id);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      marketplace: markets.find((m) => m.id === r.marketplaceId)?.name ?? "",
      url: r.url,
      sha: r.sha,
      updatedAt: r.updatedAt,
      skills: imported,
      tools: tools.map(({ id, name }) => ({ id, name })),
      agents: agents.map(({ id, name }) => ({ id, name })),
      // What the plugin offers that wasn't imported (or was added upstream since).
      available: {
        skills: r.components.skills.filter((s) => !imported.some((i) => i.name === s.name)),
        mcpServers: r.components.mcpServers.filter((s) => !tools.some((t) => t.component === s.name)),
        agents: r.components.agents.filter((a) => !agents.some((i) => i.component === a.name)),
      },
      notImported: r.notImported,
    };
  });
});

const uninstall = owner.input(Id).handler(async ({ input, context }) => {
  const plugin = await findPlugin(context.db, context.ownerId, input.id);
  // Its agents go with it, but not from under a workflow.
  const agents = await context.db.select({ id: agentsTable.id, name: agentsTable.name }).from(agentsTable).where(eq(agentsTable.pluginId, plugin.id));
  for (const agent of agents) {
    if (await agentInUse(context.db, context.ownerId, agent.id)) {
      throw new ORPCError("CONFLICT", { message: `A workflow uses ${plugin.name}'s agent “${agent.name}”: remove it from the workflow first` });
    }
  }
  await context.db.transaction(async (tx) => {
    const row = await findPlugin(tx, context.ownerId, input.id, true);
    // Its package, tools and agents go with it (cascade), but not from under anything outside it.
    await tx.select({ id: skillPackages.id }).from(skillPackages).where(eq(skillPackages.pluginId, row.id)).for("update");
    await tx.select({ id: toolsTable.id }).from(toolsTable).where(eq(toolsTable.pluginId, row.id)).for("update");
    const holder = await pluginHolder(tx, context.ownerId, row);
    if (holder) throw new ORPCError("CONFLICT", { message: holder });
    const busy = await lockAgentsForDelete(
      tx,
      agents.map((a) => a.id),
    );
    if (busy) throw new ORPCError("CONFLICT", { message: `A Job of ${plugin.name}'s agent “${busy}” is still going` });
    // Its agents first: they hold its package and tools, which the plugin's cascade removes.
    await tx.delete(agentsTable).where(eq(agentsTable.pluginId, row.id));
    await tx.delete(pluginsTable).where(eq(pluginsTable.id, row.id));
  });
});

const update = owner.input(Id).handler(async ({ input, context }) => {
  const row = await findPlugin(context.db, context.ownerId, input.id);
  const allowFile = !!context.gitFileUrls;
  // Its latest commit is what the marketplace lists now: sync it first (a failed sync keeps the entries).
  const market = await syncMarketplace(context.db, await findMarketplace(context.db, context.ownerId, row.marketplaceId), allowFile);
  const entry = market.entries.find((e) => e.name === row.entryName);
  if (!entry) throw new ORPCError("BAD_REQUEST", { message: `${market.name} no longer lists ${row.name}` });
  const { contents, url, sha } = await readEntry(market, entry, allowFile).catch(asBadRequest);
  const moved = await context.db.transaction(async (tx) => {
    await findPlugin(tx, context.ownerId, row.id, true);
    const [pkg] = await tx.select().from(skillPackages).where(eq(skillPackages.pluginId, row.id)).for("update");
    if (pkg) {
      const current = await tx.select({ name: skillsTable.name }).from(skillsTable).where(eq(skillsTable.packageId, pkg.id));
      const kept = current.map((s) => s.name).filter((name) => contents.skills.some((s) => s.name === name));
      if (kept.length === 0) throw new ORPCError("BAD_REQUEST", { message: `None of ${row.name}'s imported skills is left upstream: remove the plugin instead` });
      const { files, skills } = chosenSkills(contents, kept);
      await tx.update(skillPackages).set({ updatedAt: sql`now()` }).where(eq(skillPackages.id, pkg.id));
      await store(tx, pkg.id, files, skills);
    }
    // Imported tools follow their server's URL within its origin: the saved headers never go to a
    // host the owner didn't pick. A URL holding settings stays as the owner filled it. Headers,
    // harnesses and runners stay.
    const moved = [];
    for (const tool of await tx.select().from(toolsTable).where(eq(toolsTable.pluginId, row.id)).for("update")) {
      const server = contents.mcpServers.find((s) => s.name === tool.pluginComponent);
      if (server?.type !== "http" || tool.url === null || tool.urlSealed !== null || hasPlaceholder(server.url) || !URL.canParse(server.url)) continue;
      if (new URL(server.url).origin !== new URL(tool.url).origin) continue;
      if (server.url === tool.url && server.transport === tool.transport) continue;
      moved.push(await retarget(tx, tool, server.url, server.transport));
    }
    for (const agent of await tx.select().from(agentsTable).where(eq(agentsTable.pluginId, row.id)).for("update")) {
      const upstream = contents.agents.find((a) => a.name === agent.pluginComponent);
      if (upstream && upstream.systemPrompt !== agent.systemPrompt) {
        await tx.update(agentsTable).set({ systemPrompt: upstream.systemPrompt }).where(eq(agentsTable.id, agent.id));
      }
    }
    await tx
      .update(pluginsTable)
      .set({ url, sha, components: componentsOf(contents), notImported: contents.notImported, updatedAt: sql`now()` })
      .where(eq(pluginsTable.id, row.id));
    return moved;
  });
  for (const tool of moved) await refreshActions(context.db, context.secrets, context.tools, tool);
  return { sha };
});

export const marketplaces = { list: listMarketplaces, add: addMarketplace, remove: removeMarketplace, sync };
export const plugins = { discover, preview, install, list, uninstall, update };
