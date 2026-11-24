import { english, isMessageKey, type Message, type MessageKey, say } from "../messages/index.ts";
import { storable } from "@dispand/runner-protocol";
import { parse } from "yaml";
import { z } from "zod";
import { AgentFields } from "../agents/procedures.ts";
import { FieldInput } from "../data/tables.ts";
import { MAX_FILE_BYTES, SKILL_NAME, splitSkillMd } from "../skills/package.ts";
import { StorableText } from "../text.ts";
import { catalogEntry } from "../tools/catalog.ts";
import { INTERACTION, ROW_OPERATIONS, TriggerConfig, TriggerFields } from "../triggers/model.ts";
import { kindAt, list, Notes, PluginError, readRegular } from "./fs.ts";
import { allStorable } from "./marketplace.ts";

/**
 * The `com.dispand` extension of an Agent Plugins plugin: definitions of primitives (tables),
 * agents and triggers, files under `com.dispand/` at the plugin's root. Each is written as the
 * input of the procedure that would make it, with names where ids go, and grants nothing: it is
 * registered on install, and made only when the owner (or an approved proposal) sets it up.
 * Each file is read and checked alone: a bad one is listed as not imported and its siblings load.
 */

export const FOLDER = "com.dispand";
/** Definitions of each kind one plugin may hold. */
const MAX_DEFINITIONS = 100;
const MAX_NAMES = 100;

const Name = StorableText(100).trim().min(1);
const Names = z.array(Name).max(MAX_NAMES);

/** A field as `fields.create` takes it, with the name of the table it references in place of its id. */
const FieldDefinition = FieldInput.omit({ tableId: true, referencesTableId: true }).extend({ references: Name.optional() }).strict();

const PrimitiveDefinition = z
  .object({
    name: Name,
    primitive: z.boolean(),
    fields: z.array(FieldDefinition).max(200).default([]),
    /** The reference field (of `fields`) that names a row of the parent table, and whether every row must. */
    parent: z.object({ field: Name, required: z.boolean() }).strict().optional(),
  })
  .strict();

/** What marketplaces may still publish and Dispand no longer has: an `inbox` bundle, a trigger on Questions and Approvals. Both are skipped. */
const RETIRED_BUNDLE = "inbox";
const retiredTable = (table: string) => table.toLowerCase() === INTERACTION;

/** An agent definition's frontmatter: the body of its file is the system prompt. */
const AgentFrontmatter = AgentFields.pick({ name: true, bundles: true, selfLearning: true, consultMode: true, escalateMode: true, preferAgents: true })
  .extend({
    /** The retired `inbox` bundle is read and ignored: marketplaces still publish it. */
    bundles: z.preprocess((b) => (Array.isArray(b) ? b.filter((x) => x !== RETIRED_BUNDLE) : b), AgentFields.shape.bundles),
    description: StorableText(2000).default(""),
    /** The kind of harness it is written for, a hint for the owner's pick. */
    harness: z.enum(["cli", "cloud"]).optional(),
    /** Names of the plugin's skills. */
    skills: z.array(z.string().regex(SKILL_NAME)).max(200).default([]),
    /** Names of servers of the plugin's `mcp.json`, or `catalog:<id>` for an entry of Dispand's catalog. */
    tools: Names.default([]),
    /** The tables its Jobs may work on: all, or these, by name (the plugin's or the workspace's). */
    tables: z.union([z.literal("all"), Names]).optional(),
    /** The plugin's other agents it may consult, by definition name. `ask` is read and ignored: marketplaces still publish it. */
    consults: z
      .array(z.object({ agent: Name, ask: z.boolean().optional() }).strict())
      .max(50)
      .default([]),
  })
  .strict();

/** A primitive trigger's config with a table name and field names in place of ids. */
const PrimitiveConfig = z
  .object({
    kind: z.literal("primitive"),
    table: Name,
    operations: z.array(z.enum(["created", "updated", "deleted", "answered", "expired"])).min(1).max(3),
    fields: Names.min(1).optional(),
  })
  .strict()
  .refine((c) => retiredTable(c.table) || c.operations.every((o) => ROW_OPERATIONS.includes(o as never)), {
    message: "triggers.invalid.operations" satisfies MessageKey,
    path: ["operations"],
  });

const [Manual, Schedule, , Poll] = TriggerConfig.options;
/** A poll's config with the plugin's server (an `mcp.json` name) or a catalog entry in place of the tool's id. */
const PollConfig = Poll.omit({ toolId: true })
  .extend({ server: Name.optional(), catalog: Name.optional() })
  .strict()
  .refine((c) => (c.server === undefined) !== (c.catalog === undefined), { message: "triggers.invalid.pollSource" satisfies MessageKey, path: ["server"] });

const TriggerDefinition = TriggerFields.omit({ config: true })
  .extend({ agent: Name, config: z.union([Manual.strict(), Schedule.strict(), PrimitiveConfig, PollConfig]) })
  .strict();

export type FieldDefinition = z.infer<typeof FieldDefinition>;
export type PrimitiveDefinition = z.infer<typeof PrimitiveDefinition>;
export type AgentDefinition = z.infer<typeof AgentFrontmatter> & { systemPrompt: string };
export type TriggerDefinition = z.infer<typeof TriggerDefinition>;
export type PluginDefinitions = {
  /** The manifest's `extensions["com.dispand"].description`, when it has one. */
  description?: string;
  agents: AgentDefinition[];
  primitives: PrimitiveDefinition[];
  triggers: TriggerDefinition[];
};

export const NO_DEFINITIONS: PluginDefinitions = { agents: [], primitives: [], triggers: [] };

/** What a definition may name in the rest of its plugin. */
export type PluginNames = { skills: string[]; servers: string[] };

type Read<T> = { file: string; value: T };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A definition that didn't read: why, as a message. */
class Bad {
  constructor(readonly reason: Message) {}
}
const bad = (...args: Parameters<typeof say>) => new Bad(say(...args));

/** The first problem of a parse, in a few words: the field's path and Zod's message (its own English), never the value. */
function problem(error: z.ZodError): Bad {
  const issue = error.issues[0];
  const path = issue?.path.filter((p) => typeof p === "string" || typeof p === "number").join(".");
  if (issue?.code === "unrecognized_keys") return path ? bad("notImported.unknownFieldIn", { path }) : bad("notImported.unknownField");
  // A refinement may carry a message key (the trigger model's): shown as its English sentence.
  const words = (issue?.message && isMessageKey(issue.message) ? english(issue.message) : (issue?.message ?? "not valid")).slice(0, 200);
  return path ? bad("notImported.invalidAt", { path, words }) : bad("notImported.invalid", { words });
}

/** The files of `com.dispand/<kind>/` ending in `extension`, read as regular files of at most 2 MiB. */
function readFiles(root: string, kind: string, extension: string, notImported: Notes): { file: string; text: string }[] {
  const folder = `${FOLDER}/${kind}`;
  const at = kindAt(root, folder);
  if (at === "absent") return [];
  if (at !== "dir") {
    notImported.push({ component: "definition", name: folder, reason: say("notImported.definitionKindNotFolder") });
    return [];
  }
  const names = list(`${root}/${folder}`)
    .map((d) => d.name)
    .sort();
  const files = [];
  for (const name of names) {
    const file = `${folder}/${name}`;
    if (!storable(name) || !name.endsWith(extension)) {
      notImported.push({ component: "definition", name: storable(file) ? file : `${folder}/…`, reason: say("notImported.notExtension", { extension }) });
      continue;
    }
    const bytes = readRegular(root, file, MAX_FILE_BYTES);
    if (!bytes) {
      notImported.push({ component: "definition", name: file, reason: say("notImported.notRegularOrLarge") });
      continue;
    }
    if (files.length >= MAX_DEFINITIONS) throw new PluginError("pluginRead.tooManyDefinitions", { max: MAX_DEFINITIONS, folder });
    files.push({ file, text: bytes.toString("utf8") });
  }
  return files;
}

/** Parses each file with `parse`, skipping (and listing) one that fails or reuses a name. */
function parseAll<T extends { name: string }>(files: { file: string; text: string }[], notImported: Notes, parseOne: (text: string) => T | Bad): Read<T>[] {
  const read: Read<T>[] = [];
  for (const { file, text } of files) {
    const value = storable(text) ? parseOne(text) : bad("notImported.unstorable");
    if (value instanceof Bad) notImported.push({ component: "definition", name: file, reason: value.reason });
    else if (read.some((r) => r.value.name.toLowerCase() === value.name.toLowerCase())) {
      notImported.push({ component: "definition", name: file, reason: say("notImported.definitionDuplicate", { name: value.name }) });
    } else read.push({ file, value });
  }
  return read;
}

function parseJson<T>(schema: z.ZodType<T>, text: string): T | Bad {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad("notImported.notJson");
  }
  if (!isObject(raw)) return bad("notImported.notJsonObject");
  if (!allStorable(raw)) return bad("notImported.unstorable");
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : problem(parsed.error);
}

function parseAgent(text: string): AgentDefinition | Bad {
  const parts = splitSkillMd(text);
  if (!parts) return bad("notImported.noFrontmatter");
  let meta: unknown;
  try {
    // No alias at all: one can make a value that holds itself, or one that doubles at each level.
    meta = parse(parts.frontmatter, { maxAliasCount: 0 });
  } catch {
    return bad("notImported.yamlInvalid");
  }
  if (!isObject(meta)) return bad("notImported.frontmatterNotMapping");
  if (!allStorable(meta)) return bad("notImported.unstorable");
  const parsed = AgentFrontmatter.safeParse(meta);
  if (!parsed.success) return problem(parsed.error);
  const prompt = AgentFields.shape.systemPrompt.safeParse(parts.body.trim());
  if (!prompt.success) return bad("notImported.promptTooLong");
  return { ...parsed.data, systemPrompt: prompt.data };
}

/**
 * Drops, until none is left, each item `problemOf` finds a problem with among those still kept:
 * a definition naming one that was skipped is skipped too, with its own reason.
 */
function prune<T>(items: Read<T>[], notImported: Notes, problemOf: (item: T, kept: Read<T>[]) => Message | null): Read<T>[] {
  let kept = items;
  for (;;) {
    const next = kept.filter((item) => {
      const reason = problemOf(item.value, kept);
      if (reason) notImported.push({ component: "definition", name: item.file, reason });
      return !reason;
    });
    if (next.length === kept.length) return kept;
    kept = next;
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function primitiveProblem(p: PrimitiveDefinition, kept: Read<PrimitiveDefinition>[]): Message | null {
  const names = new Set<string>();
  for (const f of p.fields) {
    if (names.has(f.name.toLowerCase())) return say("notImported.twoFields", { field: f.name });
    names.add(f.name.toLowerCase());
    if ((f.type === "reference") !== (f.references !== undefined)) return say("notImported.referenceField", { field: f.name });
    if (f.choices?.length && f.type !== "single-select") return say("notImported.choicesField", { field: f.name });
  }
  if (!p.parent) return null;
  if (!p.primitive) return say("notImported.parentNeedsPrimitive");
  const field = p.fields.find((f) => same(f.name, p.parent!.field));
  if (field?.type !== "reference") return say("notImported.parentNotReference", { field: p.parent.field });
  // A parent is the plugin's own primitive: what a primitive is built under comes with it.
  if (same(field.references!, p.name)) return say("notImported.ownParent");
  if (!kept.some((k) => k.value.primitive && same(k.value.name, field.references!))) return say("notImported.parentNotPrimitive", { table: field.references! });
  return null;
}

function toolProblem(tool: string, names: PluginNames): Message | null {
  if (tool.startsWith("catalog:")) return catalogEntry(tool.slice("catalog:".length)) ? null : say("notImported.notCatalog", { tool });
  return names.servers.includes(tool) ? null : say("notImported.notServer", { tool });
}

function agentProblem(a: AgentDefinition, kept: Read<AgentDefinition>[], names: PluginNames): Message | null {
  const skill = a.skills.find((s) => !names.skills.includes(s));
  if (skill) return say("notImported.notSkill", { skill });
  for (const tool of a.tools) {
    const reason = toolProblem(tool, names);
    if (reason) return reason;
  }
  for (const c of a.consults) {
    if (same(c.agent, a.name)) return say("notImported.consultsSelf");
    if (!kept.some((k) => same(k.value.name, c.agent))) return say("notImported.consultNotAgent", { agent: c.agent });
  }
  return null;
}

function triggerProblem(t: TriggerDefinition, agents: Read<AgentDefinition>[], primitives: Read<PrimitiveDefinition>[], skipped: string[], names: PluginNames): Message | null {
  if (!agents.some((a) => same(a.value.name, t.agent))) return say("notImported.triggerNotAgent", { agent: t.agent });
  const { config } = t;
  if (config.kind === "primitive") {
    if (retiredTable(config.table)) return say("notImported.interactionTrigger");
    // A table the plugin doesn't define is looked for in the workspace when it is set up; one it
    // defines but skipped is no workspace table.
    if (skipped.some((name) => same(name, config.table))) return say("notImported.tableSkipped", { table: config.table });
    const table = primitives.find((p) => same(p.value.name, config.table))?.value;
    if (table && !table.primitive) return say("notImported.tableNotPrimitive", { table: table.name });
    const field = table && config.fields?.find((f) => !table.fields.some((tf) => same(tf.name, f)));
    if (field) return say("notImported.notTableField", { field, table: table!.name });
  }
  if (config.kind === "poll") return toolProblem(config.server ?? `catalog:${config.catalog}`, names);
  return null;
}

/** `extensions["com.dispand"]`: `{ description }` only, anything else listed and ignored. */
export function readExtension(value: unknown, notImported: Notes): string | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    notImported.push({ component: "manifest", name: `extensions.${FOLDER}`, reason: say("notImported.extensionNotObject") });
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (key !== "description") notImported.push({ component: "manifest", name: `extensions.${FOLDER}`, reason: say("notImported.extensionField") });
  }
  const description = StorableText(1000).safeParse(value.description);
  if (value.description !== undefined && !description.success) {
    notImported.push({ component: "manifest", name: `extensions.${FOLDER}.description`, reason: say("notImported.extensionDescription") });
  }
  return description.success ? description.data : undefined;
}

/**
 * The definitions under `com.dispand/` of a standard plugin's `root`, within `readPlugin`'s budget.
 * Every file is a regular one read without following links; a definition that doesn't parse, or
 * names what the plugin doesn't hold (a skill, a server, an agent, a parent primitive), is listed
 * as not imported, and so is one that names a definition skipped that way.
 */
export function readDefinitions(root: string, names: PluginNames, notImported: Notes): Omit<PluginDefinitions, "description"> {
  const at = kindAt(root, FOLDER);
  if (at === "absent") return { agents: [], primitives: [], triggers: [] };
  if (at !== "dir") {
    notImported.push({ component: "definition", name: FOLDER, reason: say("notImported.definitionsNotFolder") });
    return { agents: [], primitives: [], triggers: [] };
  }
  const parsedPrimitives = parseAll(readFiles(root, "primitives", ".json", notImported), notImported, (text) => parseJson(PrimitiveDefinition, text));
  const primitives = prune(parsedPrimitives, notImported, primitiveProblem);
  const skipped = parsedPrimitives.filter((p) => !primitives.includes(p)).map((p) => p.value.name);
  const agents = prune(parseAll(readFiles(root, "agents", ".md", notImported), notImported, parseAgent), notImported, (a, kept) => agentProblem(a, kept, names));
  const triggers = prune(
    parseAll(readFiles(root, "triggers", ".json", notImported), notImported, (text) => parseJson(TriggerDefinition, text)),
    notImported,
    (t) => triggerProblem(t, agents, primitives, skipped, names),
  );
  return { agents: agents.map((r) => r.value), primitives: primitives.map((r) => r.value), triggers: triggers.map((r) => r.value) };
}
