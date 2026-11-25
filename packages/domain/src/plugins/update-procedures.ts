import type { PluginContext } from "./common.ts";
import { createHash } from "node:crypto";
import { call, ORPCError } from "@orpc/server";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { type Db } from "../db/client.ts";
import { agents as agentsTable, agentSkills, fields as fieldsTable, plugins as pluginsTable, pluginConflicts, skillPackages, skills as skillsTable, skillFiles, skillFileUpstream, tables as tablesTable, tools as toolsTable, triggers as triggersTable } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { message, reasonOf, say, type Text } from "../messages/index.ts";
import { rebaseFiles, store, storeUpstream, type Tx } from "../skills/procedures.ts";
import { type After, checkChoices, inUse } from "./closure.ts";
import { changelogSection } from "./release-notes.ts";
import { applyTable, type TablePlan, tablePlan, tablesOf } from "./table-apply.ts";
import { type PrimitiveDefinition } from "./definitions.ts";
import { agentValues, type ChangeClass, elementPlans, type UpdatableKind } from "./update.ts";
import { sameValue } from "./overrides.ts";
import { agents as agentProcedures } from "../agents/procedures.ts";
import { tools as toolProcedures } from "../tools/procedures.ts";
import { triggers as triggerProcedures } from "../triggers/procedures.ts";
import { canonical, canonicalHash } from "../platform/approvals.ts";
import { fileValue, forgetConflicts, type HandedTable, reopenChanged, settleApprovals, TABLE_FIELD } from "./resolve.ts";
import { findAssistant } from "../agents/builtin.ts";
import { moveNative, nativeInstalls } from "./native.ts";
import { componentsOf, type PluginContents } from "./read-plugin.ts";
import { movesNativePin, storeNativeFiles, storePluginFiles } from "./runner-servers.ts";
import { reader, writer, acted, asBadRequest, Id, validated, chosenSkills, PluginRow, findPlugin } from "./common.ts";
import { readEntry, findMarketplace, syncMarketplace } from "./marketplace-procedures.ts";
import { lockElements, removeElements, Choices } from "./uninstall-procedures.ts";

/** The plugin as its marketplace lists it now: the entry's current commit, read. A failed sync keeps the entries. */
async function latest(context: { db: Db; access: { workspaceId: string }; gitFileUrls?: boolean }, row: PluginRow) {
  if (row.source === "generated" || !row.marketplaceId || !row.entryName) {
    throw new ORPCError("BAD_REQUEST", message("plugins.update.generated", { plugin: row.name }));
  }
  const allowFile = !!context.gitFileUrls;
  const market = await syncMarketplace(context.db, await findMarketplace(context.db, context.access.workspaceId, row.marketplaceId), allowFile);
  const entry = market.entries.find((e) => e.name === row.entryName);
  if (!entry) throw new ORPCError("BAD_REQUEST", message("plugins.update.unlisted", { marketplace: market.name, plugin: row.name }));
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
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    // Cut, and said so: the screen's token covers the whole file all the same.
    return text.length > MAX_SHOWN_TEXT ? `${text.slice(0, MAX_SHOWN_TEXT)}\n… (${text.length - MAX_SHOWN_TEXT} more characters)` : text;
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
  if (kept.length === 0) throw new ORPCError("BAD_REQUEST", message("plugins.update.nothingLeft", { plugin: row.name }));
  const next = chosenSkills(contents, kept).files;
  const mine = await db.select({ path: skillFiles.path, content: skillFiles.content }).from(skillFiles).where(eq(skillFiles.packageId, pkg.id));
  const old = await db.select({ path: skillFileUpstream.path, content: skillFileUpstream.content }).from(skillFileUpstream).where(eq(skillFileUpstream.packageId, pkg.id));
  const at = (files: { path: string; content: Uint8Array }[], path: string) => files.find((f) => f.path === path)?.content;
  const same = (a: Uint8Array | undefined, b: Uint8Array | undefined) => (a === undefined || b === undefined ? a === b : Buffer.from(a).equals(Buffer.from(b)));
  const changes: ShownChange[] = [];
  const conflicts: ShownConflict[] = [];
  // The files the plugin changes; and each conflict's files whole, as Stem gets them (the screen cuts a long one).
  const changed: string[] = [];
  const values: Record<string, { old: unknown; mine: unknown; next: unknown }> = {};
  // The agents the package's text reaches: named beside each of its files, and so under the screen's token.
  const reaches = (
    await db.select({ name: agentsTable.name }).from(agentSkills).innerJoin(agentsTable, eq(agentsTable.id, agentSkills.agentId)).where(eq(agentSkills.packageId, pkg.id)).orderBy(asc(agentsTable.name))
  ).map((a) => a.name);
  let files = rebaseFiles(mine, old, next);
  for (const path of [...new Set([...old, ...next].map((f) => f.path))].sort()) {
    const [was, now, own] = [at(old, path), at(next, path), at(mine, path)];
    if (same(was, now)) continue;
    changed.push(path);
    const shown = { key: `skill:${pkg.id}:file:${path}`, kind: "skill" as const, id: pkg.id, name: pkg.name, field: `file:${path}`, reaches };
    if (same(own, was)) changes.push({ ...shown, class: "wording", before: shownFile(was), after: shownFile(now) });
    else if (take.includes(shown.key)) files = [...files.filter((f) => f.path !== path), ...(now ? [{ path, content: now }] : [])];
    else {
      conflicts.push({ ...shown, old: shownFile(was), mine: shownFile(own), next: shownFile(now) });
      values[shown.key] = { old: fileValue(was), mine: fileValue(own), next: fileValue(now) };
    }
  }
  return { packageId: pkg.id, files, next, changes, conflicts, changed, values };
}

type Addition = { key: string; kind: "primitive" | "agent" | "trigger" | "server"; name: string; detail: Text };

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
    ...fresh(contents.definitions.primitives, had.primitives).map((d) => ({ key: `primitive:${d.name}`, kind: "primitive" as const, name: d.name, detail: say("plugins.update.tableCount", { count: d.fields.length }) })),
    ...fresh(contents.definitions.agents, had.agents).map((d) => ({ key: `agent:${d.name}`, kind: "agent" as const, name: d.name, detail: { text: d.description } })),
    ...fresh(contents.definitions.triggers, had.triggers).map((d) => ({ key: `trigger:${d.name}`, kind: "trigger" as const, name: d.name, detail: say("plugins.update.startsJobs", { agent: d.agent }) })),
    ...fresh(contents.mcpServers.filter((s) => s.type === "http"), row.components.mcpServers).map((s) => ({ key: `server:${s.name}`, kind: "server" as const, name: s.name, detail: { text: s.type === "http" ? s.url : "" } })),
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

async function leavingOf(db: Db | Tx, workspaceId: string, row: PluginRow, contents: PluginContents): Promise<Set<string>> {
  const lower = (s: string | null) => (s ?? "").toLowerCase();
  const has = (names: { name: string }[], component: string | null) => names.some((n) => lower(n.name) === lower(component));
  // A plugin is one workspace's: its elements are the rows that name it.
  const mine = (t: typeof agentsTable | typeof tablesTable | typeof toolsTable | typeof triggersTable) => eq(t.pluginId, row.id);
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

/**
 * For each of the plugin's tables the new version still defines: what differs between the
 * definition it was last merged with and the new one (`tableChanges`), with the table as it is
 * now. Each is planned, so the update keeps the new definition of every one; the screen lists
 * only those with a difference.
 */
async function tablePlans(db: Db | Tx, workspaceId: string, row: PluginRow, contents: PluginContents, leaving: Set<string>): Promise<TablePlan[]> {
  const { rowsOf, tableExists } = await tablesOf(db, workspaceId, row);
  const lower = (s: string | null) => (s ?? "").toLowerCase();
  const plans: TablePlan[] = [];
  for (const t of rowsOf) {
    const next = contents.definitions.primitives.find((d) => lower(d.name) === lower(t.pluginComponent));
    if (!t.definition || !next || leaving.has(`table:${t.id}`)) continue;
    plans.push(await tablePlan(db, t, () => t.definition!, next, tableExists));
  }
  return plans;
}

/** What an update to the plugin's current commit would do, for the owner to see: `reviewed` binds the update to it. */
async function updatePlan(context: { db: Db; access: { workspaceId: string }; gitFileUrls?: boolean }, row: PluginRow) {
  const read = await latest(context, row);
  const additions = additionsOf(row, read.contents);
  const elements = await elementPlans(context.db, context.access.workspaceId, row, read.contents, [], additions.map((a) => a.key));
  const later = elements.flatMap((e) => e.later);
  const skill = await skillPlan(context.db, row, read.contents, []);
  const conflicts: ShownConflict[] = [...elements.flatMap((e) => e.plan.conflicts), ...(skill?.conflicts ?? [])];
  const changes: ShownChange[] = [...elements.flatMap((e) => e.plan.changes), ...(skill?.changes ?? [])];
  // A skill an agent gains reaches it whole: its files are on the screen, and so under its token.
  // The plugin's own package as the update writes it; another package as it is.
  const reached: { path: string; content: Uint8Array }[][] = [];
  for (const c of changes.filter((c) => c.kind === "agent" && c.field === "skillPackageIds")) {
    const gained = (Array.isArray(c.after) ? c.after : []).filter((id): id is string => typeof id === "string" && !(Array.isArray(c.before) && c.before.includes(id)));
    if (!gained.length) continue;
    const pkgs = await context.db.select({ id: skillPackages.id, name: skillPackages.name }).from(skillPackages).where(and(inArray(skillPackages.id, gained), eq(skillPackages.workspaceId, context.access.workspaceId)));
    const stored = await context.db.select({ packageId: skillFiles.packageId, path: skillFiles.path, content: skillFiles.content }).from(skillFiles).where(inArray(skillFiles.packageId, pkgs.map((p) => p.id))).orderBy(asc(skillFiles.path));
    c.gained = pkgs.map((p) => {
      const files = skill && p.id === skill.packageId ? [...skill.files].sort((a, b) => (a.path < b.path ? -1 : 1)) : stored.filter((f) => f.packageId === p.id);
      reached.push(files);
      return { name: p.name, files: files.map((f) => ({ path: f.path, text: shownFile(f.content) })) };
    });
  }
  const leaving = await leavingOf(context.db, context.access.workspaceId, row, read.contents);
  const after = afterOf(elements);
  const removals = leaving.size ? await inUse(context.db, context.access.workspaceId, row.id, leaving, after) : [];
  const tables = await tablePlans(context.db, context.access.workspaceId, row, read.contents, leaving);
  const shownTables = tables.filter((t) => t.changes.length).map(({ tableId, name, changes }) => ({ tableId, name, changes }));
  // The screen cuts a long file: the token also covers every skill file in full, those the update writes and those an agent gains.
  const fullFiles = [skill?.files ?? [], ...reached].map((files) => files.map((f) => [f.path, createHash("sha256").update(f.content).digest("hex")]));
  const reviewed = canonicalHash({ sha: read.sha, conflicts, changes, additions, removals, tables: shownTables, fullFiles, tableValues: tables.map((t) => t.values) });
  // The plugin's own words for the version it goes to, when its changelog names it; the two commits either way.
  const { version } = read.contents;
  const releaseNotes = { from: row.sha, to: read.sha, version, text: version && read.changelog ? changelogSection(read.changelog, version) : null };
  return { ...read, conflicts, changes, additions, later, leaving, after, removals, tables, shownTables, reviewed, releaseNotes, skillValues: skill?.values ?? {} };
}

/**
 * What updating the plugin would change, before anything is done: the fields the owner changed
 * that the plugin changed too (`conflicts`, which stay theirs unless taken), and what follows the
 * plugin (`changes`: `widening`, `wording` or `silent`).
 */
/**
 * What each of the plugin's tables lacks of the definition it keeps: a change its owner declined
 * in an update, or undid since, from the table as it is now to that definition. Each change has
 * a token over the table now, the plugin's installed version, that definition and the change.
 */
async function tableDifferences(db: Db | Tx, workspaceId: string, row: PluginRow) {
  const { rowsOf, tableExists, nameOf } = await tablesOf(db, workspaceId, row);
  const lower = (s: string) => s.toLowerCase();
  const out: { plan: TablePlan; reviewed: Record<string, string> }[] = [];
  for (const t of rowsOf) {
    const stored = t.definition;
    if (!stored) continue;
    // The table as a definition would say it: the plugin's fields as they are now, under the plugin's names.
    const keptOf = (fields: TablePlan["fields"], parentField: string | null): PrimitiveDefinition => ({
      name: stored.name,
      primitive: t.primitive,
      fields: fields.flatMap((f) => {
        if (f.pluginField === null) return [];
        const target = f.referencesTableId ? nameOf(f.referencesTableId) : null;
        const said = stored.fields.find((d) => lower(d.name) === lower(f.pluginField!))?.references;
        return [{ name: f.pluginField, type: f.type, choices: f.choices, ...(target ? { references: said && lower(said) === lower(target) ? said : target } : {}) } as PrimitiveDefinition["fields"][number]];
      }),
      ...(parentField ? { parent: { field: fields.find((f) => f.name === parentField)?.pluginField ?? parentField, required: t.parentRequired } } : {}),
    });
    const plan = await tablePlan(db, t, keptOf, stored, tableExists);
    // The table's first field stays first when the update puts fields in order: a plugin field the owner put first can't be moved from here.
    const first = [plan.fields[0]?.pluginField].find((f) => f && stored.fields.some((d) => lower(d.name) === lower(f)));
    const firstInOrder = stored.fields.find((d) => plan.fields.some((f) => f.pluginField !== null && lower(f.pluginField) === lower(d.name)))?.name;
    const move = plan.changes.find((c) => c.kind === "move");
    if (move && first && firstInOrder && lower(first) !== lower(firstInOrder)) Object.assign(move, { ticked: false, stale: say("plugins.table.order") });
    const table = { name: t.name, primitive: t.primitive, parentFieldId: t.parentFieldId, parentRequired: t.parentRequired, fields: plan.fields };
    const reviewed = Object.fromEntries(plan.changes.map((c) => [c.key, canonicalHash({ sha: row.sha, definition: stored, table, change: c, values: plan.values[c.key] ?? null })]));
    if (plan.changes.length) out.push({ plan, reviewed });
  }
  return out;
}

/** The changes of each of the plugin's tables not applied to it, each with its token: shown on the plugin's row with "Apply". */
export const tableChangesOf = reader.input(Id).handler(async ({ input, context }) => {
  const row = await findPlugin(context.db, context.access.workspaceId, input.id);
  return (await tableDifferences(context.db, context.access.workspaceId, row)).map(({ plan, reviewed }) => ({ tableId: plan.tableId, name: plan.name, changes: plan.changes.map((c) => ({ ...c, reviewed: reviewed[c.key]! })) }));
});

/**
 * Applies one change `tableChanges` showed, as the update applies a ticked one. Refused when
 * the table, the plugin's version or its definition of the table changed since it was shown.
 */
export const applyTableChange = writer.input(Id.extend({ tableId: z.string().max(64), key: z.string().max(200), reviewed: z.string().length(64) })).handler(({ input, context }) => acted("applyTableChange", input.id, async () => {
  const row = await findPlugin(context.db, context.access.workspaceId, input.id);
  const found = (await tableDifferences(context.db, context.access.workspaceId, row)).find((d) => d.plan.tableId === input.tableId);
  const change = found?.plan.changes.find((c) => c.key === input.key);
  if (!found || !change || found.reviewed[change.key] !== input.reviewed) throw new ORPCError("CONFLICT", message("plugins.table.changedSince", { plugin: row.name }));
  if (change.stale || change.waiting) throw new ORPCError("BAD_REQUEST", message("plugins.update.notApplicable"));
  const failed: { name: string; reason: Text }[] = [];
  // As the update: checked, then applied through the field operations, each under its own lock. The definition kept stays: a change refused here is still a difference, shown again.
  await applyTable(context, row, found.plan, [change.key], failed);
  return failed.length ? { failed } : {};
}));

const tableOf = (kind: UpdatableKind) => (kind === "agent" ? agentsTable : kind === "tool" ? toolsTable : triggersTable);

export const updatePreview = reader.input(Id).handler(async ({ input, context }) => {
  const row = await findPlugin(context.db, context.access.workspaceId, input.id);
  const { sha, conflicts, changes, additions, later, removals, shownTables, reviewed, releaseNotes } = await updatePlan(context, row);
  // Where it is installed natively: named on the screen, moved with the update.
  const native = await nativeInstalls(context, row.id);
  return { sha, conflicts, changes, additions, later, removals, tables: shownTables, reviewed, releaseNotes, native, names: await namesIn(context.db, context.access.workspaceId, [conflicts, changes]) };
});

/** A name for each id of the owner's agents, tools, tables, fields and skill packages found in `values`, so the screen reads names. */
async function namesIn(db: Db, workspaceId: string, values: unknown): Promise<Record<string, string>> {
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
  for (const table of [agentsTable, toolsTable, tablesTable, skillPackages] as const) {
    for (const r of await db.select({ id: table.id, name: table.name }).from(table).where(and(inArray(table.id, wanted), eq(table.workspaceId, workspaceId)))) names[r.id] = r.name;
  }
  // A field is its table's: the table's workspace decides.
  const inWorkspace = db.select({ id: tablesTable.id }).from(tablesTable).where(eq(tablesTable.workspaceId, workspaceId));
  for (const r of await db.select({ id: fieldsTable.id, name: fieldsTable.name }).from(fieldsTable).where(and(inArray(fieldsTable.id, wanted), inArray(fieldsTable.tableId, inWorkspace)))) names[r.id] = r.name;
  return names;
}

/**
 * Updates the plugin to its entry's current commit. What its owner left alone follows the
 * plugin; what they changed stays, with the plugin's new value underneath, unless its conflict's
 * key is in `take`. An update with a conflict, a widening change or a change of wording applies
 * only as `updatePreview` showed it (`reviewed`); one with none applies at once. Each element is
 * written through its own procedure, with its checks; one it refuses is reported, not applied.
 */
export const update = writer.input(Id.extend({ reviewed: z.string().length(64).optional(), take: z.array(z.string().max(700)).max(1000).default([]), /** What becomes of each element the new version drops that was asked about. */ choices: Choices.default({}), /** The changes ticked of each table, by their keys. */ tables: z.record(z.string().max(64), z.array(z.string().max(200)).max(200)).default({}), /** The harnesses whose native install the screen said would move. */ native: z.array(z.string().max(64)).max(50).default([]), /** The conflicts handed to Stem ("Let Stem deal with it"), and its tables as `table:<id>`: they stay the owner's until it decides. */ stem: z.array(z.string().max(700)).max(1000).default([]) })).handler(({ input, context }) => acted("update", input.id, async () => {
  const row = await findPlugin(context.db, context.access.workspaceId, input.id);
  const shown = await updatePlan(context, row);
  const { contents, files, nativeFiles, url, sha, nativeRoot } = shown;
  if ((input.native.length || shown.conflicts.length || shown.additions.length || shown.removals.length || shown.shownTables.length || shown.changes.some((c) => c.class !== "silent")) && shown.reviewed !== input.reviewed) {
    throw new ORPCError("CONFLICT", message("plugins.update.review", { plugin: row.name }));
  }
  for (const [tableId, keys] of Object.entries(input.tables)) {
    const plan = shown.tables.find((t) => t.tableId === tableId);
    if (!plan || keys.some((k) => !plan.changes.some((c) => c.key === k && !c.stale && !c.waiting))) throw new ORPCError("BAD_REQUEST", message("plugins.update.notApplicable"));
  }
  if (input.take.some((key) => !shown.conflicts.some((c) => c.key === key))) throw new ORPCError("BAD_REQUEST", message("plugins.update.notConflict"));
  // Handed to Stem: a field of an agent, tool or trigger, or a skill's file, in conflict, not also taken; the Assistant decides it. A file is handed whole.
  const handed = shown.conflicts.filter((c) => input.stem.includes(c.key)).map((c) => ({ ...c, ...shown.skillValues[c.key] }));
  // A table shown with changes, none of them ticked: Stem decides which apply.
  const handedTables = shown.tables.filter((t) => t.changes.length && input.stem.includes(`table:${t.tableId}`));
  if (handed.length + handedTables.length !== input.stem.length || handed.some((c) => input.take.includes(c.key)) || handedTables.some((t) => input.tables[t.tableId]?.length)) throw new ORPCError("BAD_REQUEST", message("plugins.update.stemScope"));
  const toStem = handed.length + handedTables.length > 0;
  const assistant = toStem ? await findAssistant(context.db, context.actorId, context.access.workspaceId) : null;
  if (toStem && !assistant) throw new ORPCError("BAD_REQUEST", message("plugins.update.assistantFirst"));
  const elements = (await elementPlans(context.db, context.access.workspaceId, row, contents, input.take)).filter((e) => !shown.leaving.has(`${e.kind}:${e.id}`));
  const out = await context.db.transaction(async (tx) => {
    await findPlugin(tx, context.access.workspaceId, row.id, true);
    // What leaves, worked out again with the plugin's elements locked: removed only as the screen showed it.
    let out: Awaited<ReturnType<typeof removeElements>> = [];
    if (shown.leaving.size) {
      await lockElements(tx, row.workspaceId, row.id);
      const removals = await inUse(tx, context.access.workspaceId, row.id, shown.leaving, shown.after);
      if (canonical(removals) !== canonical(shown.removals)) throw new ORPCError("CONFLICT", message("plugins.update.changed", { plugin: row.name }));
      checkChoices(removals, input.choices);
      out = await removeElements(tx, context.access.workspaceId, context.engine, row, removals, input.choices);
    } else if (Object.keys(input.choices).length) throw new ORPCError("BAD_REQUEST", message("plugins.uninstall.notElement"));
    const skill = await skillPlan(tx, row, contents, input.take, true);
    if (skill) {
      const { skills } = validated(skill.files);
      await tx.update(skillPackages).set({ updatedAt: sql`now()` }).where(eq(skillPackages.id, skill.packageId));
      await store(tx, skill.packageId, skill.files, skills);
      await storeUpstream(tx, skill.packageId, skill.next);
      await reopenChanged(tx, "skill_file", skill.packageId, skill.changed.map((path) => `file:${path}`));
    }
    // A field whose plugin value changes, or a table merged again: a decision Stem was asked for on it no longer stands.
    await forgetConflicts(tx, shown.tables.map((t) => t.tableId));
    for (const e of elements) await reopenChanged(tx, e.kind, e.id, Object.keys(e.plan.upstream).filter((f) => !sameValue(e.kind, f, e.previous?.[f], e.plan.upstream[f])));
    // An element with nothing to write (its owner's values stay) only gets the plugin's new values underneath.
    for (const e of elements.filter((e) => Object.keys(e.plan.set).length === 0)) await tx.update(tableOf(e.kind)).set({ upstream: e.plan.upstream }).where(eq(tableOf(e.kind).id, e.id));
    await tx
      .update(pluginsTable)
      .set({ url, sha, nativeRoot: nativeRoot ?? null, layout: contents.layout, components: componentsOf(contents), definitions: contents.definitions, notImported: contents.notImported, digest: await storePluginFiles(tx, row.id, files), ...(movesNativePin(context) ? { nativeDigest: await storeNativeFiles(tx, row.id, nativeFiles) } : {}), updatedAt: sql`now()` })
      .where(eq(pluginsTable.id, row.id));
    return out;
  });
  context.engine.settled(out);
  // Tools first: an agent's new list may name one at its new address.
  const failed: { name: string; reason: Text }[] = [];
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
        failed.push({ name: e.name, reason: reasonOf(err) });
      }
    }
  }
  // A table handed to Stem keeps the definition it was merged with until Stem decides: what it doesn't decide is offered again.
  for (const plan of shown.tables.filter((t) => !handedTables.includes(t))) {
    const definition = await applyTable(context, row, plan, input.tables[plan.tableId] ?? [], failed);
    await context.db.update(tablesTable).set({ definition }).where(eq(tablesTable.id, plan.tableId));
  }
  await context.engine.narrowWorkspaceSessions(context.access.workspaceId, context.db);
  // An earlier update's Approval whose items this one reopened or removed left the Inbox.
  context.engine.questionChanges.publish("changed", true);
  // The native installs shown follow, at the commit the screen's token covers: what can't (or a Job, which may not touch them) is left behind, the update stays.
  const leftBehind = await moveNative(context, row.id, input.native);
  const stemJob = assistant ? await handToStem(context, row.id, assistant.agentId, handed, handedTables) : undefined;
  return { sha, ...(failed.length ? { failed } : {}), ...(leftBehind.length ? { leftBehind } : {}), ...(stemJob ? { stemJob } : {}) };
}));

/**
 * Hands conflicts to Stem: each kept as a conflict with the two values it is handed off against
 * (a table: the definition it was merged with, its structure then, and the plugin's definition
 * with the changes shown), and one Job of the Assistant, limited to `plugin_decide`, given them
 * as data. A later hand-off of the same field replaces the earlier one.
 */
export async function handToStem(context: PluginContext, pluginId: string, agentId: string, handed: ShownConflict[], tables: TablePlan[] = []): Promise<string> {
  const runId = await context.db.transaction(async (tx) => {
    const rows = [
      ...handed.map((c) => ({ id: newId("conflict"), ownerId: context.actorId, pluginId, kind: c.kind === "skill" ? ("skill_file" as const) : (c.kind as "agent" | "tool" | "trigger" | "skill_file"), elementId: c.id, field: c.field, old: c.old, mine: c.mine, next: c.next, status: "stem" as const })),
      ...tables.map((t) => ({ id: newId("conflict"), ownerId: context.actorId, pluginId, kind: "table" as const, elementId: t.tableId, field: TABLE_FIELD, old: t.kept, mine: t.fields, next: { definition: t.next, changes: t.changes } satisfies HandedTable, status: "stem" as const })),
    ];
    // A field waiting in an earlier update's Approval leaves it.
    const replaced = [];
    for (const r of rows) replaced.push(...(await tx.delete(pluginConflicts).where(and(eq(pluginConflicts.kind, r.kind), eq(pluginConflicts.elementId, r.elementId), eq(pluginConflicts.field, r.field))).returning({ runId: pluginConflicts.runId })));
    await settleApprovals(tx, replaced.map((r) => r.runId));
    await tx.insert(pluginConflicts).values(rows);
    // The values as data, each with the id plugin_decide takes.
    const data = [
      ...handed.map((c, i) => ({ id: rows[i]!.id, element: `${c.name} (${c.kind})`, field: c.field, plugin_before: c.old, owner_now: c.mine, plugin_new: c.next })),
      // A table's changes by key, with how many rows each would take values from: never a row's value.
      ...tables.map((t, i) => ({
        id: rows[handed.length + i]!.id,
        element: `${t.name} (table)`,
        field: TABLE_FIELD,
        changes: t.changes.map((c) => ({ key: c.key, kind: c.kind, ...(c.field ? { field: c.field } : {}), applicable: !c.stale && !c.waiting, ...(c.loses ? { rows_losing_values: c.loses } : {}) })),
      })),
    ];
    const id = await context.engine.createJob(tx, { ownerId: context.actorId, agentId, cause: { kind: "stem", pluginId, depth: 0 }, firing: { type: "stem", pluginId, outputs: { conflicts: JSON.stringify(data, null, 2) } } });
    await tx.update(pluginConflicts).set({ runId: id }).where(inArray(pluginConflicts.id, rows.map((r) => r.id)));
    return id;
  });
  await context.engine.announceCheckpoints();
  context.engine.questionChanges.publish("changed", true);
  await context.engine.continueRun(runId);
  return runId;
}
