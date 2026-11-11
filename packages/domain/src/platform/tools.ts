import { isProcedure } from "@orpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { fields, rows, triggers } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import type { Bundle, TableScope } from "./bundles.ts";
import { ProposeInput } from "./proposals.ts";

export { BUNDLES, type Bundle, type TableScope } from "./bundles.ts";

// Which of Dispand's procedures a Job's session gets as tools. By declaration, never by
// omission: a procedure is a tool only when it is listed here under a bundle, every other one is
// listed in NOT_TOOLS, and a test walks the router and fails on one that is in neither list.

export type PlatformTool = {
  /** The procedure's path in the router: `rows.create`. */
  path: string;
  /** The tool's name: the path with `_`. */
  name: string;
  bundle: Bundle;
  /** What the agent reads about the tool. */
  description: string;
  input: z.ZodType;
  /**
   * The tables the call reads or writes, from its input: a row or a field gives its table.
   * `null` stands for an id that names nothing the owner has, so such a call is refused like
   * one outside the Job's tables.
   */
  tables(db: Db, ownerId: string, input: unknown): Promise<(string | null)[]>;
  /** Trims an output to the Job's tables. */
  filter?(output: unknown, scope: TableScope): unknown;
  /**
   * A write that changes what agents may do: it runs only on an item of a proposal a person
   * approved for that Job (`platform/proposals.ts`), checked in `callPlatformTool`.
   */
  grant?: true;
};

type Leaf = { "~orpc": { inputSchema?: z.ZodType } };

/** Every procedure of a router, as `a.b` paths. */
export function procedurePaths(tree: object, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    isProcedure(value) ? [`${prefix}${key}`] : value && typeof value === "object" ? procedurePaths(value as object, `${prefix}${key}.`) : [],
  );
}

/** The procedure at `path`. */
export function procedureOf(tree: object, path: string): Leaf {
  const found = path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], tree);
  if (!isProcedure(found)) throw new Error(`no procedure at ${path}`);
  return found as unknown as Leaf;
}

const str = (input: unknown, key: string): string | null => {
  const value = (input as Record<string, unknown> | null)?.[key];
  return typeof value === "string" ? value : null;
};
const none = async () => [];
/** The table a primitive trigger's config watches, if it is one. */
const watchedBy = (config: unknown): (string | null)[] => {
  const c = config as { kind?: unknown; tableId?: unknown } | undefined;
  return c?.kind === "primitive" ? [typeof c.tableId === "string" ? c.tableId : null] : [];
};
/** A trigger change's tables: what its new config watches, and what the trigger watched before. */
async function triggerTables(db: Db, ownerId: string, input: unknown): Promise<(string | null)[]> {
  const id = str(input, "id");
  const [current] = id ? await db.select({ config: triggers.config }).from(triggers).where(and(eq(triggers.id, id), eq(triggers.ownerId, ownerId))) : [];
  return [...watchedBy((input as { config?: unknown })?.config), ...watchedBy(current?.config)];
}
const named = (key: string) => async (_db: Db, _ownerId: string, input: unknown) => [str(input, key)];

/** The tables of these rows; `null` for each id that isn't a row of the owner's. */
async function tablesOfRows(db: Db, ownerId: string, ids: string[]): Promise<(string | null)[]> {
  if (ids.length === 0) return [null];
  const found = await db
    .select({ id: rows.id, tableId: rows.tableId })
    .from(rows)
    .where(and(inArray(rows.id, ids), eq(rows.ownerId, ownerId)));
  return ids.map((id) => found.find((r) => r.id === id)?.tableId ?? null);
}

/**
 * Deleting rows clears the reference cells that name them, in other tables: those tables are
 * written too, so each must be within the Job's tables (any table whose reference field names
 * one of these, whether or not a cell names a deleted row).
 */
async function withReferring(db: Db, ownerId: string, tables: Promise<(string | null)[]>): Promise<(string | null)[]> {
  const own = await tables;
  const ids = own.filter((id): id is string => id !== null);
  if (ids.length === 0) return own;
  const referring = await db
    .select({ tableId: fields.tableId })
    .from(fields)
    .where(and(inArray(fields.referencesTableId, ids), eq(fields.ownerId, ownerId)));
  return [...own, ...referring.map((r) => r.tableId)];
}

/** A row's references, labels of rows of other tables: only those of tables within the Job's. */
function referencesWithin(output: unknown, scope: TableScope): unknown {
  const out = output as { references?: Record<string, { tableId: string }> };
  if (scope === "all" || !out.references) return output;
  return { ...out, references: Object.fromEntries(Object.entries(out.references).filter(([, r]) => scope.includes(r.tableId))) };
}

async function tableOfField(db: Db, ownerId: string, input: unknown): Promise<(string | null)[]> {
  const id = str(input, "id");
  const [field] = id
    ? await db
        .select({ tableId: fields.tableId })
        .from(fields)
        .where(and(eq(fields.id, id), eq(fields.ownerId, ownerId)))
    : [];
  return [field?.tableId ?? null];
}

const NEEDS_PROPOSAL = "Needs the owner's approval first: list the call with propose, ask with request_approval, then make it exactly as listed.";

function tool(path: string, bundle: Bundle, description: string, rest: Pick<PlatformTool, "tables" | "filter" | "grant">): PlatformTool {
  // `agents.setToolAsk` is `agents_set_tool_ask`: lower case with `_`, like every tool's name.
  const name = path.replace(".", "_").replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  return { path, name, bundle, description, input: procedureOf(router, path)["~orpc"].inputSchema ?? z.object({}), ...rest };
}

export const PLATFORM_TOOLS: PlatformTool[] = [
  tool("tables.list", "data", "Lists the tables you may work on, with their ids and names.", {
    tables: none,
    filter: (output, scope) => (scope === "all" ? output : (output as { id: string }[]).filter((t) => scope.includes(t.id))),
  }),
  tool("tables.get", "data", "Gives one table with its fields: their ids, names, types and choices. Row values are keyed by field id.", { tables: named("id") }),
  tool("rows.list", "data", "Lists the rows of a table, with optional filters, a sort and paging (offset, limit).", { tables: named("tableId"), filter: referencesWithin }),
  tool("rows.get", "data", "Gives one row by its id.", { tables: (db, ownerId, input) => tablesOfRows(db, ownerId, [str(input, "id") ?? ""]), filter: referencesWithin }),
  tool("rows.create", "data", "Creates a row in a table. Values are keyed by field id; fields left out stay empty.", { tables: named("tableId") }),
  tool("rows.update", "data", "Changes values of a row. Only the fields given change.", { tables: (db, ownerId, input) => tablesOfRows(db, ownerId, [str(input, "id") ?? ""]) }),
  tool("rows.delete", "data", "Deletes rows by their ids.", {
    tables: (db, ownerId, input) => {
      const ids = (input as { ids?: unknown } | null)?.ids;
      return withReferring(db, ownerId, tablesOfRows(db, ownerId, Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []));
    },
  }),
  tool("tables.create", "configure", "Creates a table. Add its fields next with fields_create.", { tables: none }),
  tool("tables.rename", "configure", "Renames a table.", { tables: named("id") }),
  tool("tables.setPrimitive", "configure", "Makes a table primitive (each change of its rows is an event that can start agents' Jobs) or not, and sets its parent table.", {
    tables: async (_db, _ownerId, input) => {
      const parent = (input as { parent?: { tableId?: unknown } | null } | null)?.parent;
      return [str(input, "id"), ...(parent && typeof parent.tableId === "string" ? [parent.tableId] : [])];
    },
  }),
  tool("fields.create", "configure", "Adds a field to a table: a name, a type and, for a choice field, its choices; for a reference, the table whose rows it names.", {
    // A reference names a second table: it too must be within the Job's tables.
    tables: async (_db, _ownerId, input) => [str(input, "tableId"), ...(str(input, "referencesTableId") === null ? [] : [str(input, "referencesTableId")])],
  }),
  tool("fields.update", "configure", "Renames a field or changes its choices.", { tables: tableOfField }),
  tool("fields.reorder", "configure", "Sets the order of a table's fields: give every field id, in the new order.", { tables: named("tableId") }),
  tool("agents.list", "configure", "Lists the agents, with their ids, harness, instructions and what their Jobs may do.", { tables: none }),
  tool("agents.get", "configure", "Gives one agent by its id, with its skills and tools.", { tables: none }),
  tool("agents.create", "configure", `Creates an agent. ${NEEDS_PROPOSAL}`, { tables: none, grant: true }),
  tool("agents.toolAsk", "configure", "Lists the actions of each tool an agent chose, with whether each asks the owner before use.", { tables: none }),
  tool("agents.setToolAsk", "configure", `Makes one action of an agent's tool ask before use, or run without asking. ${NEEDS_PROPOSAL}`, { tables: none, grant: true }),
  tool("tables.delete", "configure", `Deletes a table with its rows: this can't be undone. ${NEEDS_PROPOSAL}`, { tables: named("id"), grant: true }),
  tool("fields.delete", "configure", `Deletes a field with its values in every row: this can't be undone. ${NEEDS_PROPOSAL}`, { tables: tableOfField, grant: true }),
  tool("triggers.list", "configure", "Lists an agent's triggers: what starts its Jobs (a button, a chat, a schedule), with their instructions.", { tables: none }),
  tool("triggers.get", "configure", "Gives one trigger by its id.", { tables: none }),
  tool("triggers.create", "configure", `Creates a trigger for an agent: what starts a Job and what the agent is told then. ${NEEDS_PROPOSAL}`, { tables: async (_db, _ownerId, input) => watchedBy((input as { config?: unknown })?.config), grant: true }),
  tool("triggers.update", "configure", `Changes a trigger: its name, instructions, schedule, or whether it is on. ${NEEDS_PROPOSAL}`, { tables: triggerTables, grant: true }),
  tool("triggers.delete", "configure", `Deletes a trigger. ${NEEDS_PROPOSAL}`, { tables: triggerTables, grant: true }),
  tool("tools.list", "configure", "Lists the tools (MCP servers) agents can be given, with their ids, addresses and actions. Header values are never shown.", { tables: none }),
  tool("tools.get", "configure", "Gives one tool by its id.", { tables: none }),
  tool("tools.add", "configure", `Adds a tool: an MCP server reached at a URL, with no credentials (the owner enters those afterwards). ${NEEDS_PROPOSAL}`, { tables: none, grant: true }),
  tool("tools.delete", "configure", `Deletes a tool no agent uses, with its saved headers: this can't be undone. ${NEEDS_PROPOSAL}`, { tables: none, grant: true }),
  tool("agents.update", "configure", `Changes an agent: give every field, as agents_get shows them. ${NEEDS_PROPOSAL}`, { tables: none, grant: true }),
];

/**
 * `propose`: not a procedure of the router (it works for a Job, not for an owner), so it is
 * apart from the list above and handled by `callPlatformTool` itself.
 */
export const PROPOSE: PlatformTool = {
  path: "",
  name: "propose",
  bundle: "configure",
  description:
    "Lists writes that need the owner's approval (the tools that say so), each with the exact input you will call it with. Then ask for it with request_approval, giving the proposal's id; once approved, make each call exactly as listed, once.",
  input: ProposeInput,
  tables: none,
};

/** Every other procedure: not a tool. A new procedure goes here or above, or the walk test fails. */
export const NOT_TOOLS: string[] = [
  // Signing in and the owner's account.
  "auth.setup",
  "auth.status",
  "auth.me",
  // Runners and their pairing, harnesses and their keys.
  "runners.create",
  "runners.list",
  "runners.update",
  "runners.revoke",
  "harnesses.create",
  "harnesses.update",
  "harnesses.delete",
  "harnesses.list",
  "harnesses.get",
  "harnesses.models",
  // Tools, their headers and their sign-in.
  "tools.create",
  "tools.update",
  "tools.refresh",
  "tools.catalog",
  "tools.installFromCatalog",
  // What grants authority or can't be undone: a person does it (later, through a proposal).
  "fields.retype",
  "agents.delete",
  "skills.create",
  "skills.update",
  "skills.delete",
  "skills.list",
  "skills.get",
  "marketplaces.list",
  "marketplaces.add",
  "marketplaces.remove",
  "marketplaces.sync",
  "plugins.discover",
  "plugins.preview",
  "plugins.install",
  "plugins.list",
  "plugins.uninstall",
  "plugins.update",
  // Files and streams.
  "files.upload",
  "rows.editFiles",
  "rows.stream",
  // The owner's pages.
  "pages.home",
  "pages.list",
  "pages.get",
  "pages.create",
  "pages.rename",
  "pages.delete",
  "widgets.create",
  "widgets.update",
  "widgets.delete",
  "widgets.saveLayout",
  "onboarding.status",
  // Workflows, runs, Jobs and their questions.
  "workflows.create",
  "workflows.update",
  "workflows.delete",
  "workflows.list",
  "workflows.get",
  "workflows.setScheduleEnabled",
  "runs.start",
  "runs.sendChat",
  "runs.stop",
  "runs.get",
  "runs.stream",
  "runs.list",
  "jobs.start",
  "jobs.def",
  "questions.list",
  "questions.count",
  "questions.stream",
  "questions.answer",
];
