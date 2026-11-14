import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { call, ORPCError } from "@orpc/server";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import {
  agents as agentsTable,
  agentSkills,
  agentTools,
  fields as fieldsTable,
  harnesses,
  marketplaces as marketplacesTable,
  plugins as pluginsTable,
  pluginConflicts,
  skillPackages,
  skills as skillsTable,
  skillFiles,
  skillFileUpstream,
  tables as tablesTable,
  rows as rowsTable,
  tools as toolsTable,
  triggers as triggersTable,
  CREATED_KINDS,
} from "../db/schema.ts";
import { pluginNativeKey } from "../skills/native.ts";
import { newId } from "../ids.ts";
import { lockConsults } from "../engine/consults.ts";
import { authed, base, type InitialContext } from "../rpc/context.ts";
import { MAX_DESCRIPTION, PackageError, SKILL_NAME, validatePackage } from "../skills/package.ts";
import { rebaseFiles, resetFile, store, storeUpstream, type Tx } from "../skills/procedures.ts";
import { HeaderValue, insertTool, refreshActions } from "../tools/procedures.ts";
import { hasPlaceholder, httpTool, skillPackageName, toolName } from "./components.ts";
import { type After, checkChoices, type Element, inUse } from "./closure.ts";
import { changelogSection, readChangelog } from "./release-notes.ts";
import { type ActualTable, type TableChange, tableChanges } from "./table-merge.ts";
import type { PrimitiveDefinition } from "./definitions.ts";
import { fields, tables } from "../data/tables.ts";
import { agentValues, type ChangeClass, elementPlans, type UpdatableKind } from "./update.ts";
import { ELEMENT_FIELDS, sameValue } from "./overrides.ts";
import { agents as agentProcedures } from "../agents/procedures.ts";
import { tools as toolProcedures } from "../tools/procedures.ts";
import { triggers as triggerProcedures } from "../triggers/procedures.ts";
import { fetchGit, GitError } from "./git.ts";
import { BUILT_IN_MARKETPLACES, MarketplaceError, type MarketplaceEntry, type MarketplaceKind, parseMarketplace } from "./marketplace.ts";
import { readWellKnownIndex, readWellKnownSkills, WellKnownError, wellKnownIndexUrl } from "./well-known.ts";
import { itemsView, recordCreated } from "../platform/proposals.ts";
import { canonical } from "../platform/approvals.ts";
import { runItemsAsOwner, SetupPick, setupItems } from "./setup.ts";
import { addServer } from "./servers.ts";
import { writeFields } from "./write-field.ts";
import { answerConflict, fieldNow, forgetConflicts, ownerChoice, reopenChanged } from "./resolve.ts";
import { findAssistant } from "../agents/builtin.ts";
import { moveNative, nativeInstalls } from "./native.ts";
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
async function readEntry(market: MarketplaceRow, entry: MarketplaceEntry, allowFile: boolean): Promise<{ contents: PluginContents; url: string; sha: string; nativeRoot?: string; changelog?: string | null }> {
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
    return { contents: readPlugin(root, entry, links), url, sha: checkout.sha, nativeRoot: prefix || ".", changelog: readChangelog(root) };
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
 * What the owner reviewed of a plugin at that commit: its MCP servers as read (the marketplace's
 * manifest merged in) and its definitions, which say what its agents may do. An install of
 * servers, or one that sets definitions up, must match it.
 */
function reviewToken(sha: string, contents: PluginContents): string {
  return createHash("sha256").update(JSON.stringify([sha, contents.mcpServers, contents.definitions])).digest("hex");
}

const preview = owner.input(EntryRef).handler(async ({ input, context }) => {
  const market = await findMarketplace(context.db, context.ownerId, input.marketplaceId);
  const { contents, sha, nativeRoot } = await readEntry(market, findEntry(market, input.entryName), !!context.gitFileUrls).catch(asBadRequest);
  return { ...componentsOf(contents), definitions: contents.definitions, notImported: contents.notImported, reviewed: reviewToken(sha, contents), nativeAvailable: nativeRoot !== undefined && market.kind !== "skill-repo" };
});

/** The package these files make, or BAD_REQUEST with the reason (an owner's file may not fit the plugin's new ones). */
function validated(files: Parameters<typeof validatePackage>[0]) {
  try {
    return validatePackage(files);
  } catch (e) {
    return asBadRequest(e);
  }
}

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
  /** Register the source for an owner-approved native install without importing components. */
  nativeInstall: z.boolean().default(false),
  skills: z.array(z.string().max(64)).max(200).default([]),
  mcpServers: z.array(z.string().max(100)).max(100).default([]),
  agents: z.array(z.string().max(100)).max(100).default([]),
  /** The harness the plugin's agents run on; required when `agents` isn't empty. */
  harnessId: z.string().max(64).optional(),
  /** `preview`'s `reviewed`: the install makes what the owner saw at that commit, else `CONFLICT`. */
  reviewed: z.string().max(64).optional(),
  /** The definitions to set up once installed, as `setUp` takes them; needs `reviewed`. */
  setup: SetupPick.optional(),
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
    const setupPicked = !!input.setup && Object.values(input.setup).some((v) => Array.isArray(v) && v.length > 0);
    const nothingPicked = !picked.skills.length && !picked.mcpServers.length && !picked.agents.length && !setupPicked;
    const { harnessId } = input;
    // From a Job's approved item: bound to the commit shown, skills and the setup only. A server
    // (its address, its settings), an agent file (its tools' default grants) and a native install are the owner's to give.
    if (context.job && (input.nativeInstall || Object.keys(input.settings).length || picked.mcpServers.length || picked.agents.length)) {
      throw new ORPCError("FORBIDDEN", { message: "A proposed install picks skills and definitions only: MCP servers, agent files and native installation are the owner's to add" });
    }
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
    const { contents, url, sha, nativeRoot } = await readEntry(market, entry, !!context.gitFileUrls).catch(asBadRequest);
    // A plugin with definitions is worth installing for them alone: they are registered, and set up later.
    const { agents: agentDefs, primitives, triggers } = contents.definitions;
    if (nothingPicked && !input.nativeInstall && !agentDefs.length && !primitives.length && !triggers.length) {
      throw new ORPCError("BAD_REQUEST", { message: "Pick at least one skill, MCP server or agent" });
    }
    // Whatever it picks: its skills' files and its agents' instructions are what the owner saw too.
    if (reviewToken(sha, contents) !== input.reviewed) {
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
          nativeRoot: nativeRoot ?? null,
          layout: contents.layout,
          components: componentsOf(contents),
          definitions: contents.definitions,
          notImported: contents.notImported,
        });
        const packageId = chosen ? newId("skillpkg") : null;
        if (chosen && packageId) {
          await tx.insert(skillPackages).values({ id: packageId, ownerId: context.ownerId, name: await skillPackageName(tx, context.ownerId, name), description, pluginId });
          await store(tx, packageId, chosen.files, chosen.skills);
          await storeUpstream(tx, packageId, chosen.files);
        }
        const tools = [];
        for (const server of servers) {
          tools.push(await insertTool(tx, context.secrets, context.ownerId, { ...server.fields, name: toolName(server.name) }));
        }
        const agentIds: string[] = [];
        for (const agent of agents) {
          const id = newId("agent");
          // The agent file's `tools` and `model` aren't read: the harness decides them.
          await tx.insert(agentsTable).values({
            id,
            ownerId: context.ownerId,
            name: agent.name,
            harnessId: harnessId!,
            systemPrompt: agent.systemPrompt,
            pluginId,
            pluginComponent: agent.name,
            // The plugin's values of every field it gives an agent: a later change of one is the owner's override.
            upstream: { name: agent.name, description: "", systemPrompt: agent.systemPrompt, bundles: [], dataTables: "all", selfLearning: [], skillPackageIds: packageId ? [packageId] : [], toolIds: tools.map((t) => t.id), consults: [] },
          });
          if (packageId) await tx.insert(agentSkills).values({ agentId: id, packageId });
          if (tools.length) await tx.insert(agentTools).values(tools.map((t) => ({ agentId: id, toolId: t.id })));
          agentIds.push(id);
        }
        // What the setup would make, checked before anything is kept: a pick it can't make refuses the install.
        const setup = setupPicked ? await setupItems(tx, context.ownerId, pluginId, input.setup!, true) : null;
        if (setup && "error" in setup) throw new ORPCError("BAD_REQUEST", { message: setup.error });
        return { tools, agentIds };
      });
    } catch (err) {
      const broken = uniqueConstraint(err);
      if (broken === "skill_packages_owner_name") throw new ORPCError("CONFLICT", { message: `A skill is already called “${name}”` });
      if (broken !== null) throw new ORPCError("CONFLICT", { message: `${entry.name} is already installed` });
      throw err;
    }
    for (const tool of created.tools) await refreshActions(context.db, context.secrets, context.tools, tool);
    const made = { pluginId, toolIds: created.tools.map((t) => t.id), agentIds: created.agentIds };
    if (!setupPicked) return { ...made, setup: undefined };
    // Set up as `setUp` does, from the definitions the token covers: an item refused leaves the plugin installed, and Set up goes on from there.
    const items = await setupItems(context.db, context.ownerId, pluginId, input.setup!, true);
    if ("error" in items) throw new ORPCError("BAD_REQUEST", { message: items.error });
    // From a Job, under its context: its approved item is the owner's approval, and each item's procedure checks it as it does a call of the owner.
    const { outcomes } = await runItemsAsOwner(context, pluginId, items.items);
    return { ...made, setup: { outcomes, waiting: items.waiting } };
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

type Named = { id: string; name: string };

type CreatedKind = (typeof CREATED_KINDS)[number];

/**
 * For each plugin, what it lists as created as it is now, by kind: a row deleted since is left
 * out, and a field or trigger reads with its table or agent.
 */
async function createdNames(db: Db, ownerId: string, rows: PluginRow[]) {
  const all = (kind: CreatedKind) => [...new Set(rows.flatMap((r) => r.created[kind] ?? []))];
  const load = async (ids: string[], query: (ids: string[]) => Promise<Named[]>) => new Map((ids.length ? await query(ids) : []).map((r) => [r.id, r]));
  const found = {
    table: await load(all("table"), (ids) =>
      db.select({ id: tablesTable.id, name: tablesTable.name }).from(tablesTable).where(and(inArray(tablesTable.id, ids), eq(tablesTable.ownerId, ownerId))),
    ),
    field: await load(all("field"), (ids) =>
      db
        .select({ id: fieldsTable.id, name: sql<string>`${tablesTable.name} || '.' || ${fieldsTable.name}` })
        .from(fieldsTable)
        .innerJoin(tablesTable, eq(tablesTable.id, fieldsTable.tableId))
        .where(and(inArray(fieldsTable.id, ids), eq(fieldsTable.ownerId, ownerId))),
    ),
    agent: await load(all("agent"), (ids) =>
      db.select({ id: agentsTable.id, name: agentsTable.name }).from(agentsTable).where(and(inArray(agentsTable.id, ids), eq(agentsTable.ownerId, ownerId))),
    ),
    trigger: await load(all("trigger"), (ids) =>
      db
        .select({ id: triggersTable.id, name: sql<string>`${agentsTable.name} || ': ' || ${triggersTable.name}` })
        .from(triggersTable)
        .innerJoin(agentsTable, eq(agentsTable.id, triggersTable.agentId))
        .where(and(inArray(triggersTable.id, ids), eq(triggersTable.ownerId, ownerId))),
    ),
    tool: await load(all("tool"), (ids) =>
      db.select({ id: toolsTable.id, name: toolsTable.name }).from(toolsTable).where(and(inArray(toolsTable.id, ids), eq(toolsTable.ownerId, ownerId))),
    ),
  };
  return new Map(
    rows.map((r) => [r.id, Object.fromEntries(CREATED_KINDS.map((kind) => [kind, (r.created[kind] ?? []).flatMap((id) => found[kind].get(id) ?? [])])) as Record<CreatedKind, Named[]>]),
  );
}

/** The kind a definition's key in `created.from` makes. */
const MADE: Record<"primitive" | "agent" | "trigger", CreatedKind> = { primitive: "table", agent: "agent", trigger: "trigger" };

/** A plugin's definitions, each with whether what was set up from it is still there. */
function definitionsView(row: PluginRow, named: Record<CreatedKind, Named[]>) {
  const setUp = (key: "primitive" | "agent" | "trigger", name: string) => {
    const id = row.created.from?.[`${key}:${name}`];
    return id !== undefined && named[MADE[key]].some((n) => n.id === id);
  };
  const { agents, primitives, triggers } = row.definitions;
  return {
    agents: agents.map((d) => ({ name: d.name, description: d.description, harness: d.harness ?? null, selfLearning: d.selfLearning ?? [], setUp: setUp("agent", d.name) })),
    primitives: primitives.map((d) => ({ name: d.name, setUp: setUp("primitive", d.name) })),
    triggers: triggers.map((d) => ({ name: d.name, agent: d.agent, setUp: setUp("trigger", d.name) })),
  };
}

/** `a` and then those of `b` it doesn't hold, by id. */
const merged = (a: Named[], b: Named[]) => [...a, ...b.filter((n) => !a.some((m) => m.id === n.id))];

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
  const created = await createdNames(context.db, context.ownerId, rows);
  return rows.map((r) => {
    const named = created.get(r.id)!;
    if (r.source === "generated") {
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        source: r.source,
        marketplace: null,
        url: null,
        sha: null,
        updatedAt: r.updatedAt,
        skills: [],
        tools: named.tool,
        agents: named.agent,
        tables: named.table,
        fields: named.field,
        triggers: named.trigger,
        definitions: definitionsView(r, named),
        available: { skills: [], mcpServers: [], agents: [] },
        notImported: [],
      };
    }
    const pkg = packages.find((p) => p.pluginId === r.id);
    const imported = skillRows.filter((s) => s.packageId === pkg?.id).map((s) => ({ name: s.name, description: s.description }));
    const tools = toolRows.filter((t) => t.pluginId === r.id);
    const agents = agentRows.filter((a) => a.pluginId === r.id);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      source: r.source,
      marketplace: markets.find((m) => m.id === r.marketplaceId)?.name ?? "",
      url: r.url,
      sha: r.sha,
      updatedAt: r.updatedAt,
      skills: imported,
      // What it brought (linked to it) and what was set up from it.
      tools: merged(
        tools.map(({ id, name }) => ({ id, name })),
        named.tool,
      ),
      agents: merged(
        agents.map(({ id, name }) => ({ id, name })),
        named.agent,
      ),
      tables: named.table,
      fields: named.field,
      triggers: named.trigger,
      definitions: definitionsView(r, named),
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

/**
 * Locks every element row of the plugin, as their own writes lock them, before a removal works
 * out what is in use: an override, a row of its tables, or a new use of its skills or tools
 * (which share-locks them) waits for the removal instead of landing between the check and the
 * deletion. In the order the writes take them (the consult lock, triggers, agents, then their skills and tools).
 */
export async function lockElements(tx: Tx, ownerId: string, pluginId: string) {
  // The consult lock first, as an agent's edit and its deletion take it before the agent's row.
  await lockConsults(tx, ownerId);
  await tx.select({ id: tablesTable.id }).from(tablesTable).where(eq(tablesTable.pluginId, pluginId)).for("update");
  // Triggers before their agents, as a Job's start takes them.
  await tx.select({ id: triggersTable.id }).from(triggersTable).where(eq(triggersTable.pluginId, pluginId)).for("update");
  await tx.select({ id: agentsTable.id }).from(agentsTable).where(eq(agentsTable.pluginId, pluginId)).for("update");
  await tx.select({ id: skillPackages.id }).from(skillPackages).where(eq(skillPackages.pluginId, pluginId)).for("update");
  await tx.select({ id: toolsTable.id }).from(toolsTable).where(eq(toolsTable.pluginId, pluginId)).for("update");
}

const removalReview = (elements: Element[]) => createHash("sha256").update(canonical(elements)).digest("hex");

/**
 * What removing the plugin would ask about: each of its elements with why (its owner changed
 * it, it holds rows, memory or a running Job, something that stays uses it) and the other
 * elements it needs if kept. `reviewed` binds the removal to this list.
 */
const uninstallPreview = owner.input(Id).handler(async ({ input, context }) => {
  if (context.job) throw new ORPCError("FORBIDDEN", { message: "Plugin removal requires an owner session" });
  const row = await findPlugin(context.db, context.ownerId, input.id);
  const elements = await inUse(context.db, context.ownerId, row.id);
  return { elements, reviewed: removalReview(elements), nativeName: `dispand-${row.id}`, sourceKey: pluginNativeKey(row) ?? null };
});

/** A name among the owner's own: `name`, else `<name> (<plugin>)`, then with 2, 3… after it, cut so the whole fits a name. */
function freeName(own: Set<string>, name: string, plugin: string): string {
  let free = name;
  for (let n = 1; own.has(free.toLowerCase()); n++) {
    const suffix = ` (${plugin})${n > 1 ? ` ${n}` : ""}`.slice(-60);
    free = `${name.slice(0, 100 - suffix.length)}${suffix}`;
  }
  own.add(free.toLowerCase());
  return free;
}

/**
 * Removes a plugin's elements that leave (all of them at an uninstall, the ones its new version
 * drops at an update), in the order agents, skills, tools, tables, then triggers: one kept
 * (`keep`) becomes its owner's own, with the values it has (a tool or a table under a free
 * name); any other goes, and what used it loses it. The choices were checked (`checkChoices`).
 */
async function removeElements(tx: Tx, ownerId: string, engine: InitialContext["engine"], row: PluginRow, elements: Element[], choices: Record<string, "keep" | "delete">) {
  const of = (kind: Element["kind"], keep: boolean) => elements.filter((e) => e.kind === kind && (choices[e.key] === "keep") === keep).map((e) => e.id);

  // What leaves the plugin, kept or gone, has no conflict left: its own, and its agents' triggers'.
  const agentIds = elements.filter((e) => e.kind === "agent").map((e) => e.id);
  const agentTriggers = agentIds.length ? await tx.select({ id: triggersTable.id }).from(triggersTable).where(inArray(triggersTable.agentId, agentIds)) : [];
  await forgetConflicts(tx, [...elements.map((e) => e.id), ...agentTriggers.map((t) => t.id)]);
  // Agents first, so what still uses a skill or a tool afterwards is what stays.
  const out = await engine.deleteAgents(tx, ownerId, of("agent", false));
  for (const id of of("agent", true)) {
    await tx.update(agentsTable).set({ pluginId: null, pluginComponent: null, upstream: null, overridden: [] }).where(eq(agentsTable.id, id));
    await tx.update(triggersTable).set({ pluginId: null, pluginComponent: null, upstream: null, overridden: [] }).where(eq(triggersTable.agentId, id));
  }
  for (const id of of("skill", false)) {
    await tx.delete(agentSkills).where(eq(agentSkills.packageId, id));
    await tx.delete(skillPackages).where(eq(skillPackages.id, id));
  }
  for (const id of of("skill", true)) {
    await tx.update(skillPackages).set({ pluginId: null }).where(eq(skillPackages.id, id));
    await tx.delete(skillFileUpstream).where(eq(skillFileUpstream.packageId, id));
  }
  const names = async (table: typeof toolsTable | typeof tablesTable) =>
    new Set((await tx.select({ name: table.name }).from(table).where(and(eq(table.ownerId, ownerId), sql`${table.pluginId} is null`))).map((t) => t.name.toLowerCase()));
  for (const id of of("tool", false)) {
    await tx.delete(agentTools).where(eq(agentTools.toolId, id));
    const required = await tx.select({ id: skillPackages.id, tools: skillPackages.requiredToolIds }).from(skillPackages).where(and(eq(skillPackages.ownerId, ownerId), sql`${skillPackages.requiredToolIds} @> ${JSON.stringify([id])}::jsonb`)).for("update");
    for (const pkg of required) await tx.update(skillPackages).set({ requiredToolIds: pkg.tools.filter((toolId) => toolId !== id), updatedAt: sql`now()` }).where(eq(skillPackages.id, pkg.id));
    await tx.delete(toolsTable).where(eq(toolsTable.id, id));
  }
  const toolNames = await names(toolsTable);
  for (const id of of("tool", true)) {
    const [tool] = await tx.select({ name: toolsTable.name }).from(toolsTable).where(eq(toolsTable.id, id));
    await tx.update(toolsTable).set({ name: freeName(toolNames, tool!.name, row.name), pluginId: null, pluginComponent: null, upstream: null, overridden: [] }).where(eq(toolsTable.id, id));
  }
  // Every table to delete at once: they may name each other's rows, and no table that stays names theirs (`checkChoices`).
  const gone = of("table", false);
  if (gone.length) {
    await tx.delete(fieldsTable).where(and(inArray(fieldsTable.tableId, gone), sql`${fieldsTable.referencesTableId} is not null`));
    await tx.delete(tablesTable).where(inArray(tablesTable.id, gone));
  }
  const tableNames = await names(tablesTable);
  for (const id of of("table", true)) {
    const [table] = await tx.select({ name: tablesTable.name }).from(tablesTable).where(eq(tablesTable.id, id));
    await tx.update(tablesTable).set({ name: freeName(tableNames, table!.name, row.name), pluginId: null, pluginComponent: null, definition: null }).where(eq(tablesTable.id, id));
    await tx.update(fieldsTable).set({ pluginField: null }).where(eq(fieldsTable.tableId, id));
  }
  // A trigger dropped while its agent stays: kept as the owner's own, or gone.
  for (const id of of("trigger", true)) await tx.update(triggersTable).set({ pluginId: null, pluginComponent: null, upstream: null, overridden: [] }).where(eq(triggersTable.id, id));
  const triggersGone = of("trigger", false);
  if (triggersGone.length) await tx.delete(triggersTable).where(inArray(triggersTable.id, triggersGone));
  // What left is no longer the plugin's: its setup record forgets it, so a definition of that name can be set up again.
  const left = new Set(elements.map((e) => e.id));
  const [plugin] = await tx.select({ created: pluginsTable.created }).from(pluginsTable).where(eq(pluginsTable.id, row.id));
  if (plugin) {
    const { from = {}, ...kinds } = plugin.created;
    const created = {
      ...Object.fromEntries(Object.entries(kinds).map(([kind, ids]) => [kind, (ids ?? []).filter((id) => !left.has(id))])),
      from: Object.fromEntries(Object.entries(from).filter(([, id]) => !left.has(id))),
    };
    await tx.update(pluginsTable).set({ created }).where(eq(pluginsTable.id, row.id));
  }
  return out;
}

const Choices = z.record(z.string().max(100), z.enum(["keep", "delete"])).refine((c) => Object.keys(c).length <= 1000, "Too many choices");

/**
 * Removes the plugin and its elements, in the order agents, skills, tools, tables. An element
 * kept (`keep`) becomes its owner's own, with the values it has; any other goes, and what used
 * it loses it. Only what `uninstallPreview` showed is applied (`reviewed`), and the choices are
 * checked as a whole first (`checkChoices`).
 */
const uninstall = owner.input(Id.extend({ reviewed: z.string().length(64), choices: Choices })).handler(async ({ input, context }) => {
  if (context.job) throw new ORPCError("FORBIDDEN", { message: "Plugin removal requires an owner session" });
  const out = await context.db.transaction(async (tx) => {
    const row = await findPlugin(tx, context.ownerId, input.id, true);
    await lockElements(tx, context.ownerId, row.id);
    const elements = await inUse(tx, context.ownerId, row.id);
    if (removalReview(elements) !== input.reviewed) throw new ORPCError("CONFLICT", { message: `${row.name} changed since you looked: look at what would be removed again` });
    const problem = checkChoices(elements, input.choices);
    if (problem) throw new ORPCError("BAD_REQUEST", { message: problem });
    const out = await removeElements(tx, context.ownerId, context.engine, row, elements, input.choices);
    await tx.delete(pluginsTable).where(eq(pluginsTable.id, row.id));
    return out;
  });
  context.engine.settled(out);
  await context.engine.narrowOwnerSessions(context.ownerId, context.db);
});

/** The plugin as its marketplace lists it now: the entry's current commit, read. A failed sync keeps the entries. */
async function latest(context: { db: Db; ownerId: string; gitFileUrls?: boolean }, row: PluginRow) {
  if (row.source === "generated" || !row.marketplaceId || !row.entryName) {
    throw new ORPCError("BAD_REQUEST", { message: `${row.name} was generated in this workspace: there is nothing to update it from` });
  }
  const allowFile = !!context.gitFileUrls;
  const market = await syncMarketplace(context.db, await findMarketplace(context.db, context.ownerId, row.marketplaceId), allowFile);
  const entry = market.entries.find((e) => e.name === row.entryName);
  if (!entry) throw new ORPCError("BAD_REQUEST", { message: `${market.name} no longer lists ${row.name}` });
  return readEntry(market, entry, allowFile).catch(asBadRequest);
}

type Shown = { key: string; kind: UpdatableKind | "skill"; id: string; name: string; field: string };
/** `reaches`: for a skill's file, the agents whose sessions get the package, named on the screen since its text reaches each of them. */
type ShownChange = Shown & { class: ChangeClass; before: unknown; after: unknown; reaches?: string[]; /** For skills an agent gains: each package's files as text, since their text reaches the agent. */ gained?: { name: string; files: { path: string; text: string | null }[] }[] };
type ShownConflict = Shown & { old: unknown; mine: unknown; next: unknown; reaches?: string[] };

const MAX_SHOWN_TEXT = 20_000;
/** A file as the update's screen shows it: its text, cut, or its size when it isn't text; null when there is none. */
function shownFile(content: Uint8Array | undefined): string | null {
  if (content === undefined) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content).slice(0, MAX_SHOWN_TEXT);
  } catch {
    return `(${content.length} bytes, not text)`;
  }
}

/**
 * The plugin's skill package under an update to `contents`: the files in effect afterwards, the
 * plugin's own, and what the owner must see. A file they left alone follows the plugin (wording);
 * one they changed, added or removed that the plugin changed too is a conflict, which stays
 * theirs unless its key is in `take`.
 */
async function skillPlan(db: Db | Tx, row: PluginRow, contents: PluginContents, take: string[], lock = false) {
  const query = db.select().from(skillPackages).where(eq(skillPackages.pluginId, row.id));
  // Applying: locked as a file's edit locks it, so one saved meanwhile is read here, not overwritten.
  const [pkg] = lock ? await query.for("update") : await query;
  if (!pkg) return null;
  const current = await db.select({ name: skillsTable.name }).from(skillsTable).where(eq(skillsTable.packageId, pkg.id));
  const kept = current.map((s) => s.name).filter((name) => contents.skills.some((s) => s.name === name));
  if (kept.length === 0) throw new ORPCError("BAD_REQUEST", { message: `None of ${row.name}'s imported skills is left upstream: remove the plugin instead` });
  const next = chosenSkills(contents, kept).files;
  const mine = await db.select({ path: skillFiles.path, content: skillFiles.content }).from(skillFiles).where(eq(skillFiles.packageId, pkg.id));
  const old = await db.select({ path: skillFileUpstream.path, content: skillFileUpstream.content }).from(skillFileUpstream).where(eq(skillFileUpstream.packageId, pkg.id));
  const at = (files: { path: string; content: Uint8Array }[], path: string) => files.find((f) => f.path === path)?.content;
  const same = (a: Uint8Array | undefined, b: Uint8Array | undefined) => (a === undefined || b === undefined ? a === b : Buffer.from(a).equals(Buffer.from(b)));
  const changes: ShownChange[] = [];
  const conflicts: ShownConflict[] = [];
  // The agents the package's text reaches: named beside each of its files, and so under the screen's token.
  const reaches = (
    await db.select({ name: agentsTable.name }).from(agentSkills).innerJoin(agentsTable, eq(agentsTable.id, agentSkills.agentId)).where(eq(agentSkills.packageId, pkg.id)).orderBy(asc(agentsTable.name))
  ).map((a) => a.name);
  let files = rebaseFiles(mine, old, next);
  for (const path of [...new Set([...old, ...next].map((f) => f.path))].sort()) {
    const [was, now, own] = [at(old, path), at(next, path), at(mine, path)];
    if (same(was, now)) continue;
    const shown = { key: `skill:${pkg.id}:file:${path}`, kind: "skill" as const, id: pkg.id, name: pkg.name, field: `file:${path}`, reaches };
    if (same(own, was)) changes.push({ ...shown, class: "wording", before: shownFile(was), after: shownFile(now) });
    else if (take.includes(shown.key)) files = [...files.filter((f) => f.path !== path), ...(now ? [{ path, content: now }] : [])];
    else conflicts.push({ ...shown, old: shownFile(was), mine: shownFile(own), next: shownFile(now) });
  }
  return { packageId: pkg.id, files, next, changes, conflicts };
}

type Addition = { key: string; kind: "primitive" | "agent" | "trigger" | "server"; name: string; detail: string };

/**
 * What this version of the plugin defines that the one installed didn't: named on the update's
 * screen, and made afterwards from the plugin's Set up, which shows what each would be allowed
 * to do before it is made. The update itself makes none of it.
 */
function additionsOf(row: PluginRow, contents: PluginContents): Addition[] {
  const fresh = <T extends { name: string }>(now: T[], before: { name: string }[] | string[]) =>
    now.filter((n) => !before.some((b) => (typeof b === "string" ? b : b.name).toLowerCase() === n.name.toLowerCase()));
  const had = row.definitions;
  return [
    ...fresh(contents.definitions.primitives, had.primitives).map((d) => ({ key: `primitive:${d.name}`, kind: "primitive" as const, name: d.name, detail: `A table with ${d.fields.length} ${d.fields.length === 1 ? "field" : "fields"}` })),
    ...fresh(contents.definitions.agents, had.agents).map((d) => ({ key: `agent:${d.name}`, kind: "agent" as const, name: d.name, detail: d.description })),
    ...fresh(contents.definitions.triggers, had.triggers).map((d) => ({ key: `trigger:${d.name}`, kind: "trigger" as const, name: d.name, detail: `Starts Jobs of ${d.agent}` })),
    ...fresh(contents.mcpServers.filter((s) => s.type === "http"), row.components.mcpServers).map((s) => ({ key: `server:${s.name}`, kind: "server" as const, name: s.name, detail: s.type === "http" ? s.url : "" })),
  ];
}

/**
 * The keys (`<kind>:<id>`) of the plugin's elements its new version no longer has: an agent, a
 * table or a tool with no definition or component of its name, and a trigger with no definition
 * of its name or one that names another agent now (another trigger, then). A dropped agent's
 * triggers go with it. A skill isn't an element here: its files are followed one by one.
 */
/** What the update writes over each staying agent's uses: what a removal counts as still using a dropped element. */
const afterOf = (elements: Awaited<ReturnType<typeof elementPlans>>) =>
  new Map(elements.filter((e) => e.kind === "agent").map((e) => [e.id, e.plan.set as After]));

async function leavingOf(db: Db | Tx, ownerId: string, row: PluginRow, contents: PluginContents): Promise<Set<string>> {
  const lower = (s: string | null) => (s ?? "").toLowerCase();
  const has = (names: { name: string }[], component: string | null) => names.some((n) => lower(n.name) === lower(component));
  const mine = (t: typeof agentsTable | typeof tablesTable | typeof toolsTable | typeof triggersTable) => and(eq(t.pluginId, row.id), eq(t.ownerId, ownerId));
  const [agentRows, tableRows, toolRows, triggerRows] = await Promise.all([
    db.select({ id: agentsTable.id, component: agentsTable.pluginComponent }).from(agentsTable).where(mine(agentsTable)),
    db.select({ id: tablesTable.id, component: tablesTable.pluginComponent }).from(tablesTable).where(mine(tablesTable)),
    db.select({ id: toolsTable.id, component: toolsTable.pluginComponent }).from(toolsTable).where(mine(toolsTable)),
    db.select({ id: triggersTable.id, component: triggersTable.pluginComponent, agentId: triggersTable.agentId }).from(triggersTable).where(mine(triggersTable)),
  ]);
  const leaving = new Set<string>();
  const gone = agentRows.filter((a) => !has(contents.definitions.agents, a.component) && !has(contents.agents, a.component));
  for (const a of gone) leaving.add(`agent:${a.id}`);
  for (const t of tableRows) if (!has(contents.definitions.primitives, t.component)) leaving.add(`table:${t.id}`);
  for (const t of toolRows) if (!contents.mcpServers.some((s) => s.name === t.component)) leaving.add(`tool:${t.id}`);
  for (const t of triggerRows) {
    if (gone.some((a) => a.id === t.agentId)) continue;
    const d = contents.definitions.triggers.find((d) => lower(d.name) === lower(t.component));
    const agentId = d && agentRows.find((a) => lower(a.component) === lower(d.agent))?.id;
    if (agentId !== t.agentId) leaving.add(`trigger:${t.id}`);
  }
  return leaving;
}

type TablePlan = { tableId: string; name: string; changes: TableChange[]; kept: PrimitiveDefinition; next: PrimitiveDefinition; fields: ActualTable["fields"] };

/**
 * For each of the plugin's tables the new version still defines: what differs between the
 * definition it was last merged with and the new one (`tableChanges`), with the table as it is
 * now. Only tables with a difference are listed.
 */
async function tablePlans(db: Db | Tx, ownerId: string, row: PluginRow, contents: PluginContents, leaving: Set<string>): Promise<TablePlan[]> {
  const rowsOf = await db.select().from(tablesTable).where(and(eq(tablesTable.pluginId, row.id), eq(tablesTable.ownerId, ownerId)));
  const local = await db.select({ name: tablesTable.name }).from(tablesTable).where(and(eq(tablesTable.ownerId, ownerId), sql`${tablesTable.pluginId} is null`));
  const lower = (s: string | null) => (s ?? "").toLowerCase();
  const tableExists = (name: string) => rowsOf.some((t) => lower(t.pluginComponent) === lower(name)) || local.some((t) => lower(t.name) === lower(name));
  const plans: TablePlan[] = [];
  for (const t of rowsOf) {
    const next = contents.definitions.primitives.find((d) => lower(d.name) === lower(t.pluginComponent));
    if (!t.definition || !next || leaving.has(`table:${t.id}`)) continue;
    const fields = (await db.select().from(fieldsTable).where(eq(fieldsTable.tableId, t.id)).orderBy(asc(fieldsTable.position))).map((f) => ({ id: f.id, name: f.name, type: f.type, choices: f.choices, pluginField: f.pluginField, referencesTableId: f.referencesTableId }));
    const parentField = fields.find((f) => f.id === t.parentFieldId)?.name ?? null;
    const [counted] = await db.select({ n: sql<number>`count(*)::int` }).from(rowsTable).where(eq(rowsTable.tableId, t.id));
    const changes = tableChanges(t.definition, next, { primitive: t.primitive, parentField, parentRequired: t.parentRequired, fields }, counted?.n ?? 0, tableExists);
    if (changes.length) plans.push({ tableId: t.id, name: t.name, changes, kept: t.definition, next, fields });
  }
  return plans;
}

/** What an update to the plugin's current commit would do, for the owner to see: `reviewed` binds the update to it. */
async function updatePlan(context: { db: Db; ownerId: string; gitFileUrls?: boolean }, row: PluginRow) {
  const read = await latest(context, row);
  const elements = await elementPlans(context.db, context.ownerId, row, read.contents, []);
  const skill = await skillPlan(context.db, row, read.contents, []);
  const conflicts: ShownConflict[] = [...elements.flatMap((e) => e.plan.conflicts), ...(skill?.conflicts ?? [])];
  const changes: ShownChange[] = [...elements.flatMap((e) => e.plan.changes), ...(skill?.changes ?? [])];
  // A skill an agent gains reaches it whole: its files are on the screen, and so under its token.
  for (const c of changes.filter((c) => c.kind === "agent" && c.field === "skillPackageIds")) {
    const gained = (Array.isArray(c.after) ? c.after : []).filter((id): id is string => typeof id === "string" && !(Array.isArray(c.before) && c.before.includes(id)));
    if (!gained.length) continue;
    const pkgs = await context.db.select({ id: skillPackages.id, name: skillPackages.name }).from(skillPackages).where(and(inArray(skillPackages.id, gained), eq(skillPackages.ownerId, context.ownerId)));
    const files = await context.db.select({ packageId: skillFiles.packageId, path: skillFiles.path, content: skillFiles.content }).from(skillFiles).where(inArray(skillFiles.packageId, pkgs.map((p) => p.id))).orderBy(asc(skillFiles.path));
    c.gained = pkgs.map((p) => ({ name: p.name, files: files.filter((f) => f.packageId === p.id).map((f) => ({ path: f.path, text: shownFile(f.content) })) }));
  }
  const additions = additionsOf(row, read.contents);
  const leaving = await leavingOf(context.db, context.ownerId, row, read.contents);
  const after = afterOf(elements);
  const removals = leaving.size ? await inUse(context.db, context.ownerId, row.id, leaving, after) : [];
  const tables = await tablePlans(context.db, context.ownerId, row, read.contents, leaving);
  const shownTables = tables.map(({ tableId, name, changes }) => ({ tableId, name, changes }));
  const reviewed = createHash("sha256").update(canonical({ sha: read.sha, conflicts, changes, additions, removals, tables: shownTables })).digest("hex");
  // The plugin's own words for the version it goes to, when its changelog names it; the two commits either way.
  const { version } = read.contents;
  const releaseNotes = { from: row.sha, to: read.sha, version, text: version && read.changelog ? changelogSection(read.changelog, version) : null };
  return { ...read, conflicts, changes, additions, leaving, after, removals, tables, shownTables, reviewed, releaseNotes };
}

/**
 * What updating the plugin would change, before anything is done: the fields the owner changed
 * that the plugin changed too (`conflicts`, which stay theirs unless taken), and what follows the
 * plugin (`changes`: `widening`, `wording` or `silent`).
 */
/**
 * Applies the changes of a plugin's table its owner ticked, each through the field or table
 * operation a person would use, then keeps the new definition as the one the table was merged
 * with, but for what waits for a table that isn't there yet: offered again by the next update.
 */
async function applyTable(context: InitialContext & { ownerId: string }, row: PluginRow, plan: TablePlan, ticked: string[], failed: { name: string; reason: string }[]) {
  const lower = (s: string | null) => (s ?? "").toLowerCase();
  // The keys of the changes that failed: their part of the definition stays as it was, so the next update offers them again.
  const refused = new Set<string>();
  const run = async (key: string, path: string[], procedure: unknown, input: object, element?: { pluginId: string; component: string }): Promise<unknown> => {
    try {
      return await call(procedure as never, input as never, { context: { ...context, ...(element ? { pluginElement: element } : {}) } as never, path });
    } catch (err) {
      if (!(err instanceof ORPCError)) throw err;
      refused.add(key);
      failed.push({ name: plan.name, reason: err.message });
      return undefined;
    }
  };
  const fieldOf = (name: string) => plan.fields.find((f) => lower(f.pluginField) === lower(name));
  const [tablesNow] = [await context.db.select({ id: tablesTable.id, name: tablesTable.name, component: tablesTable.pluginComponent, pluginId: tablesTable.pluginId }).from(tablesTable).where(eq(tablesTable.ownerId, context.ownerId))];
  const tableNamed = (name: string) => tablesNow.find((t) => t.pluginId === row.id && lower(t.component) === lower(name))?.id ?? tablesNow.find((t) => t.pluginId === null && lower(t.name) === lower(name))?.id;
  const isTicked = (key: string) => ticked.includes(key);
  for (const change of plan.changes.filter((c) => isTicked(c.key) && c.kind !== "primitive" && c.kind !== "parent")) {
    const def = change.field ? plan.next.fields.find((f) => lower(f.name) === lower(change.field!)) : undefined;
    const field = change.field ? fieldOf(change.field) : undefined;
    if (change.kind === "add" && def) {
      const made = await run(change.key, ["fields", "create"], fields.create, { tableId: plan.tableId, name: def.name, type: def.type, ...(def.choices ? { choices: def.choices } : {}), ...(def.references ? { referencesTableId: tableNamed(def.references) } : {}) }, { pluginId: row.id, component: def.name });
      // Recorded as a setup records it: a later setup finds it by id.
      const id = (made as { id?: string } | undefined)?.id;
      if (id) await recordCreated(context.db, row.id, "field", id, `field:${plan.kept.name}.${def.name}`);
    } else if (change.kind === "remove" && field) await run(change.key, ["fields", "delete"], fields.delete, { id: field.id });
    else if (change.kind === "retype" && field && def) await run(change.key, ["fields", "retype"], fields.retype, { id: field.id, type: def.type, dryRun: false });
    else if (change.kind === "choices" && field && def) await run(change.key, ["fields", "update"], fields.update, { id: field.id, choices: def.choices ?? [] });
    else if (change.kind === "move") {
      const now = await context.db.select({ id: fieldsTable.id, pluginField: fieldsTable.pluginField, position: fieldsTable.position }).from(fieldsTable).where(eq(fieldsTable.tableId, plan.tableId)).orderBy(asc(fieldsTable.position));
      // The first field stays first; the plugin's fields in their new order; the owner's own after them, as they were.
      const rank = (f: (typeof now)[number]) => (f.position === 0 ? -1 : f.pluginField === null ? 10_000 + f.position : plan.next.fields.findIndex((d) => lower(d.name) === lower(f.pluginField)));
      await run(change.key, ["fields", "reorder"], fields.reorder, { tableId: plan.tableId, fieldIds: [...now].sort((a, b) => rank(a) - rank(b)).map((f) => f.id) });
    }
  }
  // The primitive flag and the parent, each as ticked: what isn't ticked stays as the table has it.
  if (isTicked("primitive") || isTicked("parent")) {
    const [table] = await context.db.select().from(tablesTable).where(eq(tablesTable.id, plan.tableId));
    const primitive = isTicked("primitive") ? plan.next.primitive : table!.primitive;
    const wanted = isTicked("parent") ? plan.next.parent : undefined;
    const wantedField = wanted ? await context.db.select({ id: fieldsTable.id, referencesTableId: fieldsTable.referencesTableId }).from(fieldsTable).where(and(eq(fieldsTable.tableId, plan.tableId), sql`lower(${fieldsTable.pluginField}) = ${lower(wanted.field)}`)).then((r) => r[0]) : undefined;
    // The plugin's parent field isn't there (its addition declined or refused): the parent stays as it is, offered again.
    const parentTicked = isTicked("parent") && !(wanted && !wantedField?.referencesTableId);
    if (isTicked("parent") && !parentTicked) {
      // Both stay offered: the parent can apply once its field is added.
      refused.add("parent").add(`add:${wanted!.field}`);
      failed.push({ name: plan.name, reason: `Its parent field ${wanted!.field} isn't there: tick its addition too` });
    }
    const current = table!.parentFieldId ? await context.db.select({ referencesTableId: fieldsTable.referencesTableId }).from(fieldsTable).where(eq(fieldsTable.id, table!.parentFieldId)).then((r) => r[0]) : undefined;
    const parent = parentTicked
      ? wanted && wantedField?.referencesTableId ? { tableId: wantedField.referencesTableId, required: wanted.required } : null
      : current?.referencesTableId ? { tableId: current.referencesTableId, required: table!.parentRequired } : null;
    const key = parentTicked ? "parent" : "primitive";
    if ((parentTicked || isTicked("primitive")) && (await run(key, ["tables", "setPrimitive"], tables.setPrimitive, { id: plan.tableId, primitive, ...(primitive ? { parent } : {}) }))) {
      // The table keeps a parent field that already names that table: when that isn't the one the plugin names, say so.
      const [after] = await context.db.select({ parentFieldId: tablesTable.parentFieldId }).from(tablesTable).where(eq(tablesTable.id, plan.tableId));
      if (parentTicked && wantedField && after?.parentFieldId !== wantedField.id) {
        refused.add("parent");
        failed.push({ name: plan.name, reason: `Its parent is another field naming the same table: make ${wanted!.field} the parent by hand` });
      }
    }
  }
  // What waits, or failed, stays as it was in the definition kept, so it is offered again; the rest is the new one, ticked or not.
  const again = plan.changes.filter((c) => c.waiting || refused.has(c.key));
  const keptField = (name: string) => plan.kept.fields.find((f) => lower(f.name) === lower(name));
  const fieldsAfter = plan.next.fields
    .filter((f) => !again.some((c) => c.kind === "add" && lower(c.field ?? "") === lower(f.name)))
    .map((f) => (again.some((c) => (c.kind === "retype" || c.kind === "choices") && lower(c.field ?? "") === lower(f.name)) ? (keptField(f.name) ?? f) : f));
  for (const c of again.filter((c) => c.kind === "remove")) {
    const was = keptField(c.field ?? "");
    if (was) fieldsAfter.push(was);
  }
  const definition: PrimitiveDefinition = {
    ...plan.next,
    fields: again.some((c) => c.kind === "move") ? [...plan.kept.fields.flatMap((k) => fieldsAfter.filter((a) => lower(a.name) === lower(k.name))), ...fieldsAfter.filter((a) => !keptField(a.name))] : fieldsAfter,
    ...(again.some((c) => c.kind === "primitive") ? { primitive: plan.kept.primitive } : {}),
    ...(again.some((c) => c.kind === "parent") ? { parent: plan.kept.parent } : {}),
  };
  await context.db.update(tablesTable).set({ definition }).where(eq(tablesTable.id, plan.tableId));
}

const tableOf = (kind: UpdatableKind) => (kind === "agent" ? agentsTable : kind === "tool" ? toolsTable : triggersTable);

const updatePreview = owner.input(Id).handler(async ({ input, context }) => {
  const row = await findPlugin(context.db, context.ownerId, input.id);
  const { sha, conflicts, changes, additions, removals, shownTables, reviewed, releaseNotes } = await updatePlan(context, row);
  // Where it is installed natively: named on the screen, moved with the update.
  const native = await nativeInstalls(context, row.id);
  return { sha, conflicts, changes, additions, removals, tables: shownTables, reviewed, releaseNotes, native, names: await namesIn(context.db, context.ownerId, [conflicts, changes]) };
});

/** A name for each id of the owner's agents, tools, tables, fields and skill packages found in `values`, so the screen reads names. */
async function namesIn(db: Db, ownerId: string, values: unknown): Promise<Record<string, string>> {
  const ids = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      if (/^[a-z]+_[0-9A-Z]{26}$/.test(v)) ids.add(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object" && v !== null) Object.values(v).forEach(walk);
  };
  walk(values);
  if (!ids.size) return {};
  const wanted = [...ids];
  const names: Record<string, string> = {};
  for (const table of [agentsTable, toolsTable, tablesTable, fieldsTable, skillPackages] as const) {
    for (const r of await db.select({ id: table.id, name: table.name }).from(table).where(and(inArray(table.id, wanted), eq(table.ownerId, ownerId)))) names[r.id] = r.name;
  }
  return names;
}

/**
 * Updates the plugin to its entry's current commit. What its owner left alone follows the
 * plugin; what they changed stays, with the plugin's new value underneath, unless its conflict's
 * key is in `take`. An update with a conflict, a widening change or a change of wording applies
 * only as `updatePreview` showed it (`reviewed`); one with none applies at once. Each element is
 * written through its own procedure, with its checks; one it refuses is reported, not applied.
 */
const update = owner.input(Id.extend({ reviewed: z.string().length(64).optional(), take: z.array(z.string().max(700)).max(1000).default([]), /** What becomes of each element the new version drops that was asked about. */ choices: Choices.default({}), /** The changes ticked of each table, by their keys. */ tables: z.record(z.string().max(64), z.array(z.string().max(200)).max(200)).default({}), /** The harnesses whose native install the screen said would move. */ native: z.array(z.string().max(64)).max(50).default([]), /** The conflicts handed to Stem ("Let Stem deal with it"): they stay the owner's until it decides. */ stem: z.array(z.string().max(700)).max(1000).default([]) })).handler(async ({ input, context }) => {
  const row = await findPlugin(context.db, context.ownerId, input.id);
  const shown = await updatePlan(context, row);
  const { contents, url, sha, nativeRoot } = shown;
  if ((input.native.length || shown.conflicts.length || shown.additions.length || shown.removals.length || shown.tables.length || shown.changes.some((c) => c.class !== "silent")) && shown.reviewed !== input.reviewed) {
    throw new ORPCError("CONFLICT", { message: `Look at what updating ${row.name} changes before it is applied` });
  }
  for (const [tableId, keys] of Object.entries(input.tables)) {
    const plan = shown.tables.find((t) => t.tableId === tableId);
    if (!plan || keys.some((k) => !plan.changes.some((c) => c.key === k && !c.stale && !c.waiting))) throw new ORPCError("BAD_REQUEST", { message: "Not a change of this table that can be applied" });
  }
  if (input.take.some((key) => !shown.conflicts.some((c) => c.key === key))) throw new ORPCError("BAD_REQUEST", { message: "Not a field in conflict" });
  // Handed to Stem: a field of an agent, tool or trigger in conflict, not also taken; the Assistant decides it.
  const handed = shown.conflicts.filter((c) => input.stem.includes(c.key));
  if (handed.length !== input.stem.length || handed.some((c) => c.kind === "skill" || input.take.includes(c.key))) throw new ORPCError("BAD_REQUEST", { message: "Stem decides fields of agents, tools and triggers in conflict, that you didn't take" });
  const assistant = handed.length ? await findAssistant(context.db, context.ownerId) : null;
  if (handed.length && !assistant) throw new ORPCError("BAD_REQUEST", { message: "Set the Assistant up first: Stem is the Assistant" });
  const elements = (await elementPlans(context.db, context.ownerId, row, contents, input.take)).filter((e) => !shown.leaving.has(`${e.kind}:${e.id}`));
  const out = await context.db.transaction(async (tx) => {
    await findPlugin(tx, context.ownerId, row.id, true);
    // What leaves, worked out again with the plugin's elements locked: removed only as the screen showed it.
    let out: Awaited<ReturnType<typeof removeElements>> = [];
    if (shown.leaving.size) {
      await lockElements(tx, context.ownerId, row.id);
      const removals = await inUse(tx, context.ownerId, row.id, shown.leaving, shown.after);
      if (canonical(removals) !== canonical(shown.removals)) throw new ORPCError("CONFLICT", { message: `${row.name} changed since you looked: look at what updating it changes again` });
      const problem = checkChoices(removals, input.choices);
      if (problem) throw new ORPCError("BAD_REQUEST", { message: problem });
      out = await removeElements(tx, context.ownerId, context.engine, row, removals, input.choices);
    } else if (Object.keys(input.choices).length) throw new ORPCError("BAD_REQUEST", { message: "Not an element of this plugin" });
    const skill = await skillPlan(tx, row, contents, input.take, true);
    if (skill) {
      const { skills } = validated(skill.files);
      await tx.update(skillPackages).set({ updatedAt: sql`now()` }).where(eq(skillPackages.id, skill.packageId));
      await store(tx, skill.packageId, skill.files, skills);
      await storeUpstream(tx, skill.packageId, skill.next);
    }
    // A field whose plugin value changes: a decision Stem was asked for on it no longer stands.
    for (const e of elements) await reopenChanged(tx, e.kind, e.id, Object.keys(e.plan.upstream).filter((f) => !sameValue(e.kind, f, e.previous?.[f], e.plan.upstream[f])));
    // An element with nothing to write (its owner's values stay) only gets the plugin's new values underneath.
    for (const e of elements.filter((e) => Object.keys(e.plan.set).length === 0)) await tx.update(tableOf(e.kind)).set({ upstream: e.plan.upstream }).where(eq(tableOf(e.kind).id, e.id));
    await tx
      .update(pluginsTable)
      .set({ url, sha, nativeRoot: nativeRoot ?? null, layout: contents.layout, components: componentsOf(contents), definitions: contents.definitions, notImported: contents.notImported, updatedAt: sql`now()` })
      .where(eq(pluginsTable.id, row.id));
    return out;
  });
  context.engine.settled(out);
  // Tools first: an agent's new list may name one at its new address.
  const failed: { name: string; reason: string }[] = [];
  for (const kind of ["tool", "agent", "trigger"] as const) {
    for (const e of elements.filter((e) => e.kind === kind && Object.keys(e.plan.set).length)) {
      const procedure = kind === "tool" ? toolProcedures.update : kind === "agent" ? agentProcedures.update : triggerProcedures.update;
      const table = tableOf(kind);
      // The plugin's new values go underneath first: the element's own update then reads what differs from them as its owner's.
      await context.db.update(table).set({ upstream: e.plan.upstream }).where(eq(table.id, e.id));
      try {
        // An agent is written whole: as it is now, not as it was when the plan was made, with the plugin's fields over it.
        const [agent] = kind === "agent" ? await context.db.select().from(agentsTable).where(eq(agentsTable.id, e.id)) : [];
        const now = agent ? await agentValues(context.db, agent) : null;
        // A tool the update gives it starts with every action on Ask: the screen showed the tool, not what of it would run unasked.
        const gained = now && Array.isArray(e.plan.set.toolIds) ? (e.plan.set.toolIds as string[]).filter((toolId) => !now.toolIds.includes(toolId)) : [];
        const written = now ? { ...now, ...e.plan.set, id: e.id, ...(gained.length ? { toolPermissions: gained.map((toolId) => ({ toolId, unasked: [] })) } : {}) } : { ...e.plan.set, id: e.id };
        await call(procedure as never, written as never, { context: context as never });
      } catch (err) {
        if (!(err instanceof ORPCError)) throw err;
        // Refused: what was underneath stays, so the next update offers the change again.
        await context.db.update(table).set({ upstream: e.previous }).where(eq(table.id, e.id));
        failed.push({ name: e.name, reason: err.message });
      }
    }
  }
  for (const plan of shown.tables) await applyTable(context, row, plan, input.tables[plan.tableId] ?? [], failed);
  await context.engine.narrowOwnerSessions(context.ownerId, context.db);
  // The native installs shown follow, at the commit the screen's token covers: what can't (or a Job, which may not touch them) is left behind, the update stays.
  const leftBehind = await moveNative(context, row.id, input.native);
  const stemJob = assistant ? await handToStem(context, row.id, assistant.agentId, handed) : undefined;
  return { sha, ...(failed.length ? { failed } : {}), ...(leftBehind.length ? { leftBehind } : {}), ...(stemJob ? { stemJob } : {}) };
});

/**
 * Hands conflicts to Stem: each kept as a conflict with the two values it is handed off against,
 * and one Job of the Assistant, limited to `plugin_decide`, given them as data. A later hand-off
 * of the same field replaces the earlier one.
 */
async function handToStem(context: InitialContext & { ownerId: string }, pluginId: string, agentId: string, handed: ShownConflict[]): Promise<string> {
  const runId = await context.db.transaction(async (tx) => {
    const rows = handed.map((c) => ({ id: newId("conflict"), ownerId: context.ownerId, pluginId, kind: c.kind as "agent" | "tool" | "trigger", elementId: c.id, field: c.field, old: c.old, mine: c.mine, next: c.next, status: "stem" as const }));
    for (const r of rows) await tx.delete(pluginConflicts).where(and(eq(pluginConflicts.kind, r.kind), eq(pluginConflicts.elementId, r.elementId), eq(pluginConflicts.field, r.field)));
    await tx.insert(pluginConflicts).values(rows);
    // The values as data, each with the id plugin_decide takes.
    const data = rows.map((r, i) => ({ id: r.id, element: `${handed[i]!.name} (${r.kind})`, field: r.field, plugin_before: r.old, owner_now: r.mine, plugin_new: r.next }));
    const id = await context.engine.createJob(tx, { ownerId: context.ownerId, agentId, cause: { kind: "stem", pluginId, depth: 0 }, firing: { type: "stem", pluginId, outputs: { conflicts: JSON.stringify(data, null, 2) } } });
    await tx.update(pluginConflicts).set({ runId: id }).where(inArray(pluginConflicts.id, rows.map((r) => r.id)));
    return id;
  });
  await context.engine.announceCheckpoints();
  await context.engine.continueRun(runId);
  return runId;
}

const SetupInput = z.object({ id: z.string(), pick: SetupPick });
const setupReview = (items: unknown) => createHash("sha256").update(canonical(items)).digest("hex");

/** The items `setUp` would make now, in words as a proposal shows them, and what can't be made yet. */
const setupPreview = owner.input(SetupInput).handler(async ({ input, context }) => {
  const setup = await setupItems(context.db, context.ownerId, input.id, input.pick);
  if ("error" in setup) throw new ORPCError("BAD_REQUEST", { message: setup.error });
  return { ...(await itemsView(context.db, context.ownerId, setup.items)), waiting: setup.waiting, reviewed: setupReview(setup.items) };
});

/**
 * Sets up the definitions picked: the same items an approved proposal would make, made by the
 * owner, who is the person approving. Stops at the first refusal; the next run resumes.
 */
const setUp = owner.input(SetupInput.extend({ reviewed: z.string().length(64) })).handler(async ({ input, context }) => {
  const setup = await setupItems(context.db, context.ownerId, input.id, input.pick);
  if ("error" in setup) throw new ORPCError("BAD_REQUEST", { message: setup.error });
  if (setupReview(setup.items) !== input.reviewed) throw new ORPCError("CONFLICT", { message: "The setup changed since you reviewed it: look at the updated list before setting it up" });
  const { outcomes } = await runItemsAsOwner(context, input.id, setup.items);
  return { outcomes, waiting: setup.waiting };
});

/**
 * Puts a field of a plugin's agent or tool back to the plugin's value, through the element's own
 * update, so every check of an ordinary change applies (a tool sent back to another origin loses its headers).
 */
const resetOverride = owner.input(z.object({ kind: z.enum(["agent", "tool", "trigger", "skill"]), id: z.string().max(64), field: z.string().max(600) })).handler(async ({ input, context }) => {
  const { kind, id, field } = input;
  if (kind === "skill") {
    // A skill's fields are its files: `file:<path>`.
    if (!field.startsWith("file:")) throw new ORPCError("BAD_REQUEST", { message: "Not a field a plugin sets" });
    await context.db.transaction((tx) => resetFile(tx, context.ownerId, id, field.slice("file:".length)));
    await context.engine.narrowOwnerSessions(context.ownerId, context.db);
    return { overridden: [] };
  }
  if (!(ELEMENT_FIELDS[kind].overridable as readonly string[]).includes(field)) throw new ORPCError("BAD_REQUEST", { message: "Not a field a plugin sets" });
  const table = kind === "agent" ? agentsTable : kind === "tool" ? toolsTable : triggersTable;
  const [row] = await context.db
    .select({ upstream: table.upstream })
    .from(table)
    .where(and(eq(table.id, id), eq(table.ownerId, context.ownerId)));
  if (!row) throw new ORPCError("NOT_FOUND");
  if (!row.upstream || !(field in row.upstream)) throw new ORPCError("BAD_REQUEST", { message: "No plugin's value to go back to" });
  const value = { [field]: row.upstream[field] };
  // The setting that filled it was sealed with the address the override replaced.
  if (kind === "tool" && field === "url" && hasPlaceholder(String(value.url))) {
    throw new ORPCError("BAD_REQUEST", { message: "The plugin's address needs a setting: update the plugin, or uninstall and install it again, to enter it" });
  }
  return writeFields(context, kind, id, value);
});

export const marketplaces = { list: listMarketplaces, add: addMarketplace, remove: removeMarketplace, sync };
const ElementRef = z.object({ kind: z.enum(["agent", "tool", "trigger"]), id: z.string().max(64) });

/** The conflicts of one of a plugin's elements: with Stem, waiting for the owner's Approval, or theirs again. */
const conflicts = owner.input(ElementRef).handler(async ({ input, context }) => {
  if (context.job) throw new ORPCError("FORBIDDEN");
  const rows = await context.db
    .select()
    .from(pluginConflicts)
    .where(and(eq(pluginConflicts.ownerId, context.ownerId), eq(pluginConflicts.kind, input.kind), eq(pluginConflicts.elementId, input.id)))
    .orderBy(asc(pluginConflicts.field));
  // The values as they are now, which the owner decides on: a choice carries their token.
  return Promise.all(rows.map((r) => conflictView(context.db, r)));
});

/** A conflict as the element's page shows it: the field's value now, the plugin's now, Stem's suggestion, and the token of the three. */
async function conflictView(db: Db, r: typeof pluginConflicts.$inferSelect) {
  const now = await fieldNow(db, r);
  const shown = { id: r.id, field: r.field, status: r.status, mine: now?.value ?? r.mine, next: now?.plugin ?? r.next, merged: r.status === "approval" ? r.merged : null };
  return { ...shown, reviewed: createHash("sha256").update(canonical(shown)).digest("hex") };
}

/**
 * The owner's choice on a conflict: on Stem's merged value, accept or decline it; on one that is
 * theirs again, keep their value, take the plugin's, or hand it to Stem once more.
 */
const resolveConflict = owner.input(z.object({ id: z.string().max(64), choice: z.enum(["accept", "decline", "mine", "plugin", "stem"]), reviewed: z.string().length(64) })).handler(async ({ input, context }) => {
  if (context.job) throw new ORPCError("FORBIDDEN");
  // Decided on the values the page showed: one that changed since (another update, an edit) is shown again.
  const [row] = await context.db.select().from(pluginConflicts).where(and(eq(pluginConflicts.id, input.id), eq(pluginConflicts.ownerId, context.ownerId)));
  if (!row) throw new ORPCError("NOT_FOUND");
  if ((await conflictView(context.db, row)).reviewed !== input.reviewed) throw new ORPCError("CONFLICT", { message: "This field changed since you looked: look at it again" });
  const actor = { type: "user" as const, userId: context.ownerId };
  if (input.choice === "accept" || input.choice === "decline") {
    if ((await answerConflict(context, actor, input.id, input.choice === "accept")) === "gone") throw new ORPCError("NOT_FOUND");
  } else if (input.choice === "mine" || input.choice === "plugin") {
    await ownerChoice(context, actor, input.id, input.choice);
  } else {
    const [c] = await context.db.select().from(pluginConflicts).where(and(eq(pluginConflicts.id, input.id), eq(pluginConflicts.ownerId, context.ownerId), eq(pluginConflicts.status, "open")));
    if (!c) throw new ORPCError("NOT_FOUND");
    const now = await fieldNow(context.db, c);
    const assistant = await findAssistant(context.db, context.ownerId);
    if (!now || !assistant) throw new ORPCError("BAD_REQUEST", { message: !now ? "It is no longer the plugin's" : "Set the Assistant up first: Stem is the Assistant" });
    const table = c.kind === "agent" ? agentsTable : c.kind === "tool" ? toolsTable : triggersTable;
    const [element] = await context.db.select({ name: table.name }).from(table).where(eq(table.id, c.elementId));
    // Handed off again against the values as they are now.
    await handToStem(context, c.pluginId, assistant.agentId, [{ key: `${c.kind}:${c.elementId}:${c.field}`, kind: c.kind, id: c.elementId, name: element?.name ?? c.kind, field: c.field, old: c.old, mine: now.value, next: now.plugin }]);
  }
  await context.engine.narrowOwnerSessions(context.ownerId, context.db);
  return { ok: true };
});

export const plugins = { discover, preview, install, list, uninstallPreview, uninstall, update, setupPreview, setUp, resetOverride, addServer, updatePreview, conflicts, resolveConflict };
