import { call, ORPCError } from "@orpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { fields as fieldsTable, plugins, tables as tablesTable, type ProposalItem } from "../db/schema.ts";
import { fields, tables } from "../data/tables.ts";
import { logError } from "../log.ts";
import { CREATES, parseWithRefs, recordCreated, resolveRefs } from "../platform/proposals.ts";
import type { InitialContext } from "../rpc/context.ts";
import { emitLog, meter, recordError, tracer } from "../telemetry/index.ts";
import type { PrimitiveDefinition } from "./definitions.ts";

// Setting a workspace up from a plugin's definitions: `setupItems` turns the definitions picked
// into the items a proposal lists (`{ "$item": n }` where an id goes), and `runItemsAsOwner` makes
// them for the owner, through the same procedures. What each item makes is recorded in the
// plugin's `created`, and under its definition in `created.from`: a run stopped on the way is
// resumed from there, by id, never by a name.

const Name = z.string().trim().min(1).max(100);

/** What the owner picks to set up: definitions by name (agents, triggers and servers come later). */
export const SetupPick = z.object({
  primitives: z.array(Name).max(100).optional(),
  agents: z
    .array(z.object({ name: Name, harnessId: z.string().max(64) }))
    .max(100)
    .optional(),
  triggers: z.array(Name).max(100).optional(),
  servers: z
    .array(z.object({ name: Name, runnerId: z.string().max(64).optional() }))
    .max(100)
    .optional(),
});
export type SetupPick = z.infer<typeof SetupPick>;

/** A definition that can't be made yet, and why. */
export type Waiting = { definition: string; reason: string };

/** The procedures a setup's items call, by tool name, and each one's path for its span. */
const PROCEDURES = {
  tables_create: { procedure: tables.create, path: ["tables", "create"] },
  fields_create: { procedure: fields.create, path: ["fields", "create"] },
  tables_set_primitive: { procedure: tables.setPrimitive, path: ["tables", "setPrimitive"] },
} as const;
type SetupTool = keyof typeof PROCEDURES;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
type Ref = string | { $item: number };

/**
 * The items that set up the definitions picked, in order: every table first, then every field,
 * then what makes a table primitive, so a reference or a parent always names a table already
 * made. A definition this plugin made before is reused by its recorded id while that row exists,
 * whatever it is called now; a table or field that is gone is made again. A table name that isn't
 * one of the plugin's definitions names a table of the workspace. Each item is parsed with its
 * procedure's input, as a proposal's is.
 */
export async function setupItems(db: Db, ownerId: string, pluginId: string, pick: SetupPick): Promise<{ items: ProposalItem[]; waiting: Waiting[] } | { error: string }> {
  const [plugin] = await db
    .select({ definitions: plugins.definitions, created: plugins.created })
    .from(plugins)
    .where(and(eq(plugins.id, pluginId), eq(plugins.ownerId, ownerId)));
  if (!plugin) return { error: "Plugin not found" };
  const { primitives } = plugin.definitions;
  const from = plugin.created.from ?? {};
  const waiting: Waiting[] = [];
  for (const a of pick.agents ?? []) waiting.push({ definition: `agent:${a.name}`, reason: "Agents aren't set up from a plugin yet" });
  for (const t of pick.triggers ?? []) waiting.push({ definition: `trigger:${t}`, reason: "Triggers aren't set up from a plugin yet" });
  for (const s of pick.servers ?? []) waiting.push({ definition: `server:${s.name}`, reason: "Servers aren't added from a plugin yet" });

  const picked: PrimitiveDefinition[] = [];
  for (const name of pick.primitives ?? []) {
    const definition = primitives.find((p) => same(p.name, name));
    if (!definition) return { error: `“${name}” isn't a table definition of this plugin` };
    if (!picked.includes(definition)) picked.push(definition);
  }

  // What this plugin made before, still there: its tables (picked or not) and the picked ones' fields.
  const recordedTables = primitives.flatMap((p) => from[`primitive:${p.name}`] ?? []);
  const tableRows = recordedTables.length
    ? await db
        .select({ id: tablesTable.id, primitive: tablesTable.primitive, parentFieldId: tablesTable.parentFieldId })
        .from(tablesTable)
        .where(and(inArray(tablesTable.id, recordedTables), eq(tablesTable.ownerId, ownerId)))
    : [];
  const recordedFields = picked.flatMap((p) => p.fields.flatMap((f) => from[`field:${p.name}.${f.name}`] ?? []));
  const fieldRows = recordedFields.length
    ? await db
        .select({ id: fieldsTable.id, tableId: fieldsTable.tableId })
        .from(fieldsTable)
        .where(and(inArray(fieldsTable.id, recordedFields), eq(fieldsTable.ownerId, ownerId)))
    : [];
  const existing = (p: PrimitiveDefinition) => tableRows.find((t) => t.id === from[`primitive:${p.name}`]);

  const items: ProposalItem[] = [];
  // Each plugin table this setup can name: made before, or by an item of this one.
  const tableOf = new Map<string, Ref>();
  for (const p of primitives) {
    const row = existing(p);
    if (row) tableOf.set(p.name.toLowerCase(), row.id);
    else if (picked.includes(p)) {
      tableOf.set(p.name.toLowerCase(), { $item: items.length });
      items.push({ tool: "tables_create", input: { name: p.name }, from: `primitive:${p.name}` });
    }
  }
  const pluginTable = (name: string, by: PrimitiveDefinition): Ref | { error: string } =>
    tableOf.get(name.toLowerCase()) ?? { error: `“${by.name}” names the table “${name}” of this plugin: pick it too` };

  // Tables of the workspace a field names, by name: those that aren't the plugin's own.
  const outside = [...new Set(picked.flatMap((p) => p.fields.flatMap((f) => (f.references && !primitives.some((d) => same(d.name, f.references!)) ? [f.references.toLowerCase()] : []))))];
  const workspace = outside.length
    ? await db
        .select({ id: tablesTable.id, name: tablesTable.name })
        .from(tablesTable)
        .where(and(eq(tablesTable.ownerId, ownerId), inArray(sql`lower(${tablesTable.name})`, outside)))
    : [];

  for (const p of picked) {
    const table = tableOf.get(p.name.toLowerCase())!;
    for (const f of p.fields) {
      const key = `field:${p.name}.${f.name}`;
      // Kept while it is still a field of the table it was made in.
      if (typeof table === "string" && fieldRows.some((r) => r.id === from[key] && r.tableId === table)) continue;
      // Every table is made with its Name field.
      if (same(f.name, "Name")) {
        waiting.push({ definition: key, reason: "Every table has a Name field already: this one isn't added" });
        continue;
      }
      let references: Ref | undefined;
      if (f.references !== undefined) {
        if (primitives.some((d) => same(d.name, f.references!))) {
          const ref = pluginTable(f.references, p);
          if (typeof ref === "object" && "error" in ref) return ref;
          references = ref;
        } else {
          references = workspace.find((t) => same(t.name, f.references!))?.id;
          if (!references) {
            waiting.push({ definition: key, reason: `No table of the workspace is called “${f.references}”` });
            continue;
          }
        }
      }
      const input = { tableId: table, name: f.name, type: f.type, ...(f.choices ? { choices: f.choices } : {}), ...(references === undefined ? {} : { referencesTableId: references }) };
      items.push({ tool: "fields_create", input, from: key });
    }
  }

  for (const p of picked) {
    if (!p.primitive && !p.parent) continue;
    const row = existing(p);
    // A table made before keeps how the owner has it, unless it lacks what the definition sets.
    if (row && row.primitive === p.primitive && (!p.parent || row.parentFieldId !== null)) continue;
    let parent: { tableId: Ref; required: boolean } | undefined;
    if (p.parent) {
      const field = p.fields.find((f) => same(f.name, p.parent!.field))!;
      const ref = pluginTable(field.references!, p);
      if (typeof ref === "object" && "error" in ref) return ref;
      parent = { tableId: ref, required: p.parent.required };
    }
    items.push({ tool: "tables_set_primitive", input: { id: tableOf.get(p.name.toLowerCase())!, primitive: p.primitive, ...(parent ? { parent } : {}) } });
  }

  // Parsed as each procedure takes it, references standing for ids, as a proposal's items are.
  for (const [i, item] of items.entries()) {
    const parsed = parseWithRefs(PROCEDURES[item.tool as SetupTool].procedure["~orpc"].inputSchema!, item.input);
    if ("error" in parsed) return { error: `Item ${i + 1} (${item.tool}): ${parsed.error}` };
    item.input = parsed.data;
  }
  return { items, waiting };
}

/** How each item of a setup ended. */
export type ItemOutcome = { $item: number; tool: string; from?: string; outcome: "made" | "refused" | "not made"; id?: string; error?: string };

const traces = tracer("plugins");
const counts = meter("plugins");

/** The id a create returned. */
const idOf = (output: unknown): string | null => {
  const id = (output as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : null;
};

/**
 * Makes a setup's items in order, as the owner (their own context, through each item's
 * procedure), references replaced by what earlier items created. Stops at the first refusal:
 * nothing is undone, and the next setup resumes from what the plugin recorded.
 */
export function runItemsAsOwner(context: InitialContext & { ownerId: string }, pluginId: string, items: ProposalItem[]): Promise<{ outcomes: ItemOutcome[] }> {
  return traces.startActiveSpan("plugins.setup", { attributes: { "dispand.plugin.id": pluginId, "dispand.setup.items": items.length } }, async (span) => {
    let result = "done";
    try {
      const made: ProposalItem[] = [];
      const outcomes: ItemOutcome[] = [];
      for (const [index, item] of items.entries()) {
        const at = { $item: index, tool: item.tool, ...(item.from ? { from: item.from } : {}) };
        if (result === "stopped") {
          outcomes.push({ ...at, outcome: "not made" });
          made.push(item);
          continue;
        }
        const input = resolveRefs(made, item.input);
        let error: string | null = input === null ? "It names an item that created nothing" : null;
        let output: unknown;
        if (input !== null) {
          const { procedure, path } = PROCEDURES[item.tool as SetupTool];
          try {
            output = await call(procedure as never, input as never, { context: context as never, path: [...path] });
          } catch (err) {
            if (err instanceof ORPCError) error = err.code === "NOT_FOUND" ? "Not found" : err.message;
            else {
              logError("plugin setup item failed", err, { ref: `${pluginId}:${item.tool}` });
              error = "It failed";
            }
          }
        }
        if (error !== null) {
          result = "stopped";
          outcomes.push({ ...at, outcome: "refused", error });
          made.push(item);
          continue;
        }
        const kind = CREATES[item.tool];
        const id = kind ? idOf(output) : null;
        if (kind && id) await recordCreated(context.db, pluginId, kind, id, item.from);
        made.push(id ? { ...item, createdId: id } : item);
        outcomes.push({ ...at, outcome: "made", ...(id ? { id } : {}) });
      }
      const count = outcomes.filter((o) => o.outcome === "made").length;
      span.setAttribute("dispand.setup.made", count);
      if (result === "stopped") {
        recordError(span, "stopped");
        emitLog("plugins", "info", "plugin setup stopped", { "dispand.plugin.id": pluginId, "dispand.setup.items": items.length, "dispand.setup.made": count });
      }
      return { outcomes };
    } catch (err) {
      result = "failed";
      throw err;
    } finally {
      span.setAttribute("dispand.result", result);
      counts.counter("dispand.plugins.setups").add(1, { "dispand.result": result });
      span.end();
    }
  });
}
