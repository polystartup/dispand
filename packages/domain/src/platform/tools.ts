import { isProcedure } from "@orpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { fields, rows, runs, triggers } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import type { Bundle, TableScope } from "./bundles.ts";
import { INTERACTION } from "../triggers/model.ts";
import { ApplyInput, CREATES, ProposeInput, type ProposalName } from "./proposals.ts";
import type { JobIdentity, PlatformApp, ToolResult } from "./call.ts";
import { signalsWithin } from "../assistant/review.ts";
import { AnswerInput, answerQuestion, getQuestion, GetInput, listQuestions, ListInput } from "../questions/inbox.ts";
import { readMemory, ReadInput, RemoveInput, removeMemoryTool, tablesOf, WriteInput, writeMemoryTool } from "../memory/tools.ts";
import type { Rights } from "./rights.ts";

export { BUNDLES, type Bundle, type TableScope } from "./bundles.ts";

// Which of Dispand's procedures a Job's session gets as tools. By declaration, never by
// omission: a procedure is a tool only when it is listed here under a bundle, every other one is
// listed in NOT_TOOLS, and a test walks the router and fails on one that is in neither list. The
// Job's own tools that are no procedure (proposals, the Inbox's, memory) are declared here too.

export type PlatformTool = {
  /** The procedure's path in the router: `rows.create`. */
  path: string;
  /** The tool's name: the path with `_`. */
  name: string;
  /** The bundle that gives the tool; `null` for one that `available` gives instead. */
  bundle: Bundle | null;
  /** Whether the Job's rights give the tool, in place of its bundle (memory: the self-learning targets). */
  available?(rights: Rights): boolean;
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
  /**
   * A configuration write that needs no proposal but may be listed in one, so a whole setup is
   * approved at once. A grant is a write too. Reads are neither, and are never proposal items.
   */
  write?: true;
  /** What the call creates: its kind, and its id read from the output. An item may name it with `{ "$item": n }`. */
  creates?: { kind: ProposalName["kind"]; id(output: unknown): string | null };
  /** A tool that works for the Job itself, not as its owner: no procedure of the router, run here instead. */
  run?(app: PlatformApp, job: JobIdentity, input: unknown, rights: Rights): Promise<ToolResult>;
};

/** Whether the Job's rights give the tool: its bundle, or its own rule when it has one. */
export function allowed(tool: PlatformTool, rights: Rights): boolean {
  return tool.available ? tool.available(rights) : tool.bundle !== null && rights.bundles.includes(tool.bundle);
}

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
  // Questions and Approvals (the built-in `interaction`) are no table: the agent's `inbox` decides.
  if (c?.kind !== "primitive" || c.tableId === INTERACTION) return [];
  return [typeof c.tableId === "string" ? c.tableId : null];
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

/**
 * What a call naming a Job touches: the whole workspace. A transcript holds whatever its Job
 * read, through any tool (rows, other transcripts, Questions it answered, a consult's answer),
 * and from tables deleted since, so only a Job on every table reads it; a list of tables never
 * includes this. `null` for an id that is no Job of the owner's.
 */
export const WHOLE_WORKSPACE = "*";
async function wholeWorkspace(db: Db, ownerId: string, input: unknown): Promise<(string | null)[]> {
  const id = str(input, "id") ?? str(input, "runId");
  const [job] = id
    ? await db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.id, id), eq(runs.ownerId, ownerId), eq(runs.source, "agent")))
    : [];
  return [job ? WHOLE_WORKSPACE : null];
}

const NEEDS_PROPOSAL = "Needs the owner's approval first: list the call with propose, ask with request_approval, then make it exactly as listed.";

/** The id of what a create returned: its view's `id`. */
const idOf = (output: unknown): string | null => {
  const id = (output as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : null;
};

function tool(path: string, bundle: Bundle, description: string, rest: Pick<PlatformTool, "tables" | "filter" | "grant" | "write">): PlatformTool {
  // `agents.setToolPermission` is `agents_set_tool_permission`: lower case with `_`, like every tool's name.
  const name = path.replace(".", "_").replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  const kind = CREATES[name];
  return { path, name, bundle, description, input: procedureOf(router, path)["~orpc"].inputSchema ?? z.object({}), ...rest, ...(kind ? { creates: { kind, id: idOf } } : {}) };
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
  tool("tables.create", "configure", "Creates a table. Add its fields next with fields_create.", { tables: none, write: true }),
  tool("tables.rename", "configure", "Renames a table.", { tables: named("id"), write: true }),
  tool("tables.setPrimitive", "configure", "Makes a table primitive (each change of its rows is an event that can start agents' Jobs) or not, and sets its parent table.", {
    tables: async (_db, _ownerId, input) => {
      const parent = (input as { parent?: { tableId?: unknown } | null } | null)?.parent;
      return [str(input, "id"), ...(parent && typeof parent.tableId === "string" ? [parent.tableId] : [])];
    },
    write: true,
  }),
  tool("fields.create", "configure", "Adds a field to a table: a name, a type and, for a choice field, its choices; for a reference, the table whose rows it names.", {
    // A reference names a second table: it too must be within the Job's tables.
    tables: async (_db, _ownerId, input) => [str(input, "tableId"), ...(str(input, "referencesTableId") === null ? [] : [str(input, "referencesTableId")])],
    write: true,
  }),
  tool("fields.update", "configure", "Renames a field or changes its choices.", { tables: tableOfField, write: true }),
  tool("fields.reorder", "configure", "Sets the order of a table's fields: give every field id, in the new order.", { tables: named("tableId"), write: true }),
  tool("agents.list", "configure", "Lists the agents, with their ids, harness, instructions and what their Jobs may do.", { tables: none }),
  tool("agents.get", "configure", "Gives one agent by its id, with its skills and tools.", { tables: none }),
  tool("agents.create", "configure", `Creates an agent. ${NEEDS_PROPOSAL}`, { tables: none, grant: true }),
  tool("agents.toolAsk", "configure", "Lists the actions of each tool an agent chose, with their Run, Ask or Off permissions.", { tables: none }),
  tool("harnesses.limits", "configure", "Lists every harness: whether it is a CLI on a runner (with the runner's name and whether it is connected now) or a cloud provider, its kind and model, how many of its sessions may work at once, and how many work and wait now.", { tables: none }),
  tool("harnesses.setLimit", "configure", `Sets how many sessions of a harness may work at once: raising it lets agents spend more, lowering it holds back others' work. ${NEEDS_PROPOSAL}`, { tables: none, grant: true }),
  tool("workspace.checkpoint", "configure", "Gives the workspace's checkpoint: how many Jobs of one root cause go before a person is asked to let them go on.", { tables: none }),
  tool("workspace.setCheckpoint", "configure", `Sets the workspace's checkpoint: raising it lets agents spend more before a person is asked, lowering it holds back others' work. ${NEEDS_PROPOSAL}`, { tables: none, grant: true }),
  tool("agents.setToolPermission", "configure", `Sets one action of an agent's tool to run without asking, ask before use, or be off. ${NEEDS_PROPOSAL}`, { tables: none, grant: true }),
  tool("tables.delete", "configure", `Deletes a table with its rows: this can't be undone. ${NEEDS_PROPOSAL}`, { tables: named("id"), grant: true }),
  tool("fields.delete", "configure", `Deletes a field with its values in every row: this can't be undone. ${NEEDS_PROPOSAL}`, { tables: tableOfField, grant: true }),
  tool("triggers.list", "configure", "Lists an agent's triggers: what starts its Jobs (a button, a chat, a schedule), with their instructions.", { tables: none }),
  tool("triggers.get", "configure", "Gives one trigger by its id.", { tables: none }),
  tool("triggers.create", "configure", `Creates a trigger for an agent: what starts a Job and what the agent is told then. ${NEEDS_PROPOSAL}`, { tables: async (_db, _ownerId, input) => watchedBy((input as { config?: unknown })?.config), grant: true }),
  tool("triggers.update", "configure", `Changes a trigger: its name, instructions, schedule, or whether it is on. ${NEEDS_PROPOSAL}`, { tables: triggerTables, grant: true }),
  tool("triggers.delete", "configure", `Deletes a trigger. ${NEEDS_PROPOSAL}`, { tables: triggerTables, grant: true }),
  tool("jobs.list", "configure", "Lists the latest Jobs, newest first, of one agent or trigger or with one status if given: what made each, how it went, when, and the ids of its Questions and Approvals still waiting.", { tables: none }),
  tool("jobs.get", "configure", "Gives one Job with its transcript (a page of its messages, oldest first, and how many there are) and its Questions and Approvals with their answers. Only an agent on every table reads it.", { tables: wholeWorkspace }),
  tool("jobs.def", "configure", "Gives a Job's definition as it was created: its agent, its trigger and the instructions it was given. Only an agent on every table reads it.", { tables: wholeWorkspace }),
  tool("workspace.review", "configure", "Reviews the workspace for what could be better: agents with no trigger, tables no agent works on, tools waiting for their owner to sign in, Questions and Approvals open more than three days, and buttons pressed at the same hour often enough to be a schedule. Each signal has the ids it names and a key: write the key in the request_approval message of its proposal, so that once the owner declines it, it isn't raised again for 30 days.", {
    tables: none,
    filter: signalsWithin,
  }),
  tool("audit.list", "configure", "Lists the Audit, newest first, 50 rows a page (give the next field as cursor for more): what each Job, person and the scheduler did, with when, on what (a type and an id), how it ended, and ids, names, counts and kinds as details; never the values, messages or answers. Filter by actor type, agent, Job, action or its family (job, question, platform...), resource, result, or a time range. Rows about a table outside yours are left out.", {
    tables: none,
  }),
  tool("workflows.list", "configure", "Lists the workflows, with their ids, names and when each was last changed.", { tables: none }),
  tool("tools.list", "configure", "Lists the tools (MCP servers) agents can be given, with their ids, addresses and actions. Header values are never shown.", { tables: none }),
  tool("tools.get", "configure", "Gives one tool by its id.", { tables: none }),
  tool("tools.catalog", "configure", "Lists the catalog's ready-made tools: for each, how it is reached (over HTTP, or on the owner's runner), its settings' names, and the actions it declares with whether each only reads, may be polled, and asks before use by default.", { tables: none }),
  tool("tools.addFromCatalog", "configure", `Adds a tool from the catalog by its id, with no credentials: the owner enters them, or signs in, on the tool's page afterwards (its signInPath). It starts with the actions its entry declares, so their flags and poll triggers can be set at once. An entry that runs on a runner can't be added this way. ${NEEDS_PROPOSAL}`, { tables: none, grant: true }),
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
    'Lists configuration writes for the owner to approve at once: those that need it (the tools that say so) and any other you want shown with them, each with the exact input. Where an id goes, { "$item": n } names what the earlier item n (from 0) creates. Then ask with request_approval, giving the proposal\'s id; once approved, call proposal_apply with it.',
  input: ProposeInput,
  tables: none,
};

/** `proposal_apply`: like `propose`, the Job's own, handled by `callPlatformTool`, which runs each item through itself. */
export const APPLY: PlatformTool = {
  path: "",
  name: "proposal_apply",
  bundle: "configure",
  description:
    "Makes the calls of an approved proposal of yours for you, in order, each exactly as listed and checked like a direct call; a reference to an earlier item becomes the id that item created. Stops at the first call refused and gives each item's outcome. Call it again to go on from the first item not made yet.",
  input: ApplyInput,
  tables: none,
};

/**
 * The `inbox` bundle: other agents' open Questions, each call within what the Job may reach
 * (`questions/inbox.ts`). Not the owner's `questions.*` procedures, which see the whole Inbox.
 */
export const INBOX_TOOLS: PlatformTool[] = [
  {
    path: "",
    name: "questions_list",
    bundle: "inbox",
    description: "Lists the open Questions of other agents' Jobs that you may answer, newest first: their ids, who asked and what.",
    input: ListInput,
    tables: none,
    run: (app, job) => listQuestions(app, job),
  },
  {
    path: "",
    name: "questions_get",
    bundle: "inbox",
    description: "Gives one open Question by its id: who asked, and each question with its options.",
    input: GetInput,
    tables: none,
    run: (app, job, input) => getQuestion(app, job, input as never),
  },
  {
    path: "",
    name: "questions_answer",
    bundle: "inbox",
    description:
      "Answers one open Question: for each question asked (keyed by its exact text), one of its options' labels, or your own words; several for a multiSelect one. The asking Job is told your agent answered.",
    input: AnswerInput,
    tables: none,
    run: (app, job, input) => answerQuestion(app, job, input as never),
  },
];

const tableOfScope = async (_db: Db, _ownerId: string, input: unknown) => tablesOf(input);
const learns = (rights: Rights) => rights.selfLearning.length > 0;

/**
 * Memory (`memory/tools.ts`): every Job reads; a Job whose self-learning names a target writes
 * there. A table scope's table must be within the Job's tables, like any call.
 */
export const MEMORY_TOOLS: PlatformTool[] = [
  {
    path: "",
    name: "memory_read",
    bundle: null,
    available: () => true,
    description:
      "Reads a memory: the workspace's, your agent's, or a table's you work on. Without a path, its index (one line per entry, grouped by type); with a path, that entry, who wrote it and whether a person accepted it.",
    input: ReadInput,
    tables: tableOfScope,
    run: (app, job, input, rights) => readMemory(app, job, input as never, rights),
  },
  {
    path: "",
    name: "memory_add",
    bundle: null,
    available: learns,
    description:
      "Adds an entry to a memory you may write (your agent's, a table's you work on, or the workspace's, as your self-learning allows): one fact the Jobs that come next need, at a path that has no entry yet. Memory is not a log.",
    input: WriteInput,
    tables: tableOfScope,
    run: (app, job, input, rights) => writeMemoryTool(app, job, input as never, rights, "add"),
  },
  {
    path: "",
    name: "memory_update",
    bundle: null,
    available: learns,
    description: "Rewrites the entry at a path of a memory you may write: give every field, as it should read now.",
    input: WriteInput,
    tables: tableOfScope,
    run: (app, job, input, rights) => writeMemoryTool(app, job, input as never, rights, "update"),
  },
  {
    path: "",
    name: "memory_remove",
    bundle: null,
    available: learns,
    description: "Removes the entry at a path of a memory you may write, once it is wrong or no longer needed. The owner can bring it back.",
    input: RemoveInput,
    tables: tableOfScope,
    run: (app, job, input, rights) => removeMemoryTool(app, job, input as never, rights),
  },
];

/** Every other procedure: not a tool. A new procedure goes here or above, or the walk test fails. */
export const NOT_TOOLS: string[] = [
  "assistantCommands",
  // Signing in and the owner's account.
  "auth.setup",
  "auth.status",
  "auth.me",
  // Runners and their pairing, harnesses and their keys.
  "runners.create",
  "runners.list",
  "runners.update",
  "runners.revoke",
  // Native installation is an owner action, never a Job tool.
  "runners.plugins",
  "runners.installUpdate",
  "runners.workspacePlugin",
  "runners.workspaceSkills",
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
  "tools.authorize",
  "tools.installFromCatalog",
  "tools.fillSettings",
  // What polls may read: the owner's choice, never an agent's.
  "tools.pollable",
  "tools.setPollable",
  "tools.setActionEnabled",
  // What grants authority or can't be undone: a person does it (later, through a proposal).
  "fields.retype",
  "agents.delete",
  // Saved native CLI permissions belong to the owner, never to Job tools.
  "agents.cliRules",
  "agents.removeCliRule",
  // The Assistant: made by the owner's action, never by an agent.
  "agents.assistant",
  "agents.ensureAssistant",
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
  "plugins.uninstallPreview",
  "plugins.uninstall",
  "plugins.update",
  "plugins.setupPreview",
  "plugins.setUp",
  "plugins.addServer",
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
  "workflows.get",
  "workflows.setScheduleEnabled",
  "runs.start",
  "runs.sendChat",
  "runs.stop",
  "runs.get",
  "runs.stream",
  "runs.list",
  "jobs.start",
  "jobs.consults",
  "questions.list",
  "questions.count",
  "questions.stream",
  "questions.answer",
  // Audit: the owner's page for now (an agent's read comes with its tool); where traces are opened.
  "audit.traceUrl",
  // How long Audit is kept: shortening it erases the trail of what agents did, so no agent reads
  // or changes it, not even through a proposal.
  "workspace.auditRetention",
  "workspace.setAuditRetention",
  // The owner's memory pages; agents have their own memory tools, gated by their targets.
  "memories.list",
  "memories.get",
  "memories.write",
  "memories.remove",
  "memories.accept",
  "memories.revert",
  "memories.restore",
];
