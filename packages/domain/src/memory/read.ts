import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { runs, tables } from "../db/schema.ts";
import { rightsOf } from "../platform/rights.ts";
import { meter, recordError, tracer } from "../telemetry/index.ts";
import { MEMORY_TYPES, type MemoryScope, type MemoryType } from "./model.ts";
import { listMemory, type MemoryEntry, memoryIndex } from "./store.ts";

// What a Job reads of memory at each session start (design 6.5), decided once here, and its
// renderings: the system prompt's block (and the runner's files after it). Read at the start,
// not snapshotted: memory is information, not authority, and what the last Job wrote reaches the
// next one. Rights are read as they are now, so a table or `data` taken back is left out.

type RunRow = typeof runs.$inferSelect;

const traces = tracer("memory");
const prompts = meter("memory").counter("dispand.memory.prompts", { description: "Memory put in a Job's session start: none, whole or cut to its budget" });

/** One scope a Job reads: its label, its entries in index order, and how many were withheld from a Job that configures. */
export type JobMemoryScope = { where: MemoryScope; label: string; entries: MemoryEntry[]; withheld: number };
export type JobMemory = { scopes: JobMemoryScope[] };

/** A scope as filled: the entries kept, and how many of its entries didn't fit. */
export type FittedScope = JobMemoryScope & { omitted: number };
/** What fitted, in order, and what was left out, named for the closing line. */
export type FittedMemory = { scopes: FittedScope[]; leftOut: string[] };

/** The prompt's memory block at most, in characters: the workspace's and the agent's indexes (35,000 each at most) always fit. */
export const MEMORY_PROMPT_BUDGET = 96_000;
/** The closing line names at most this many scopes, then counts the rest, so its size is bounded. */
const CLOSING_ITEMS = 20;

/** An entry a Job without `configure` wrote, that no person accepted since: it never instructs a Job that configures. */
export const unaccepted = (e: MemoryEntry) => e.author.type === "agent" && !e.author.configure && e.acceptedAt === null;

/**
 * The memory a Job reads now: the workspace's, its agent's, then with `data` the memory of every
 * table within its tables (the primitive trigger's table first, the others by name). For a Job
 * that configures, an entry written by a Job that doesn't, and not accepted by a person, is left
 * out and counted. Nothing once the Job is over.
 */
export async function memoryForJob(db: Db, run: RunRow): Promise<JobMemory> {
  if (run.source !== "agent" || !run.agentId) return { scopes: [] };
  const rights = await rightsOf(db, { runId: run.id, ownerId: run.ownerId, agentId: run.agentId });
  if (!rights) return { scopes: [] };
  const where: { where: MemoryScope; label: string }[] = [
    { where: { scope: "workspace" }, label: "Workspace" },
    { where: { scope: "agent", agentId: run.agentId }, label: "This agent" },
  ];
  if (rights.bundles.includes("data")) {
    const owned = await db.select({ id: tables.id, name: tables.name }).from(tables).where(eq(tables.ownerId, run.ownerId)).orderBy(asc(tables.name), asc(tables.id));
    const within = rights.tables === "all" ? owned : owned.filter((t) => (rights.tables as string[]).includes(t.id));
    const first = run.trigger.type === "event" ? run.trigger.outputs.table_id : undefined;
    within.sort((a, b) => Number(b.id === first) - Number(a.id === first));
    for (const t of within) where.push({ where: { scope: "table", tableId: t.id }, label: `Table ${t.name} (${t.id})` });
  }
  const configure = rights.bundles.includes("configure");
  const scopes: JobMemoryScope[] = [];
  for (const w of where) {
    const all = sorted(await listMemory(db, run.ownerId, w.where));
    const entries = configure ? all.filter((e) => !unaccepted(e)) : all;
    scopes.push({ ...w, entries, withheld: all.length - entries.length });
  }
  return { scopes };
}

/** Index order: by type, in `MEMORY_TYPES`' order, then by path, as `memoryIndex` lists them. */
function sorted(entries: MemoryEntry[]): MemoryEntry[] {
  const rank = (e: MemoryEntry) => MEMORY_TYPES.indexOf(e.type as MemoryType);
  return [...entries].sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** How one rendering lays memory out, each part with what joins it to the one before, and how it is measured. */
export type MemoryLayout = {
  /** What comes before any scope when anything is sent. */
  head: string;
  /** A scope's heading and whole index (with the line counting what was withheld). */
  index(scope: JobMemoryScope): string;
  /** One entry of a scope. */
  entry(scope: JobMemoryScope, entry: MemoryEntry): string;
  /** What names what was left out; empty when nothing was. */
  closing(leftOut: string[]): string;
  /** A part's size, in the budget's unit, as it is sent. */
  size(part: string): number;
};

/** A scope that says something: one with entries, or with entries withheld. */
const speaks = (s: JobMemoryScope) => s.entries.length > 0 || s.withheld > 0;

/** How the closing line names a scope: left out whole, or with `n` entries that didn't fit. */
const leftOutItem = (s: JobMemoryScope, n: number | "all") => (n === "all" ? `${s.label}, whole` : `${s.label}, ${n} ${n === 1 ? "entry" : "entries"}`);

/** The closing list: at most `CLOSING_ITEMS` scopes named, the rest counted. */
function closingList(items: string[]): string[] {
  return items.length <= CLOSING_ITEMS ? items : [...items.slice(0, CLOSING_ITEMS), `and ${items.length - CLOSING_ITEMS} more`];
}

/**
 * The one fill rule of both renderings: every scope's whole index first (the workspace's and the
 * agent's always; a table's left out whole once it no longer fits), then the entries of the scopes
 * kept, in order, until one doesn't fit. The closing line naming what was left out is sent too:
 * its largest possible size is kept aside before anything is filled.
 */
export function fitMemory(memory: JobMemory, budget: number, layout: MemoryLayout): FittedMemory {
  const scopes = memory.scopes.filter(speaks);
  if (scopes.length === 0) return { scopes: [], leftOut: [] };
  // The largest closing line possible: every scope named at its longest, the longest first.
  const longest = scopes.map((s) => {
    const items = [leftOutItem(s, "all"), leftOutItem(s, s.entries.length)];
    return layout.size(items[0]!) >= layout.size(items[1]!) ? items[0]! : items[1]!;
  });
  longest.sort((a, b) => layout.size(b) - layout.size(a));
  let used = layout.size(layout.head) + layout.size(layout.closing(closingList(longest)));
  // Pass 1: indexes.
  const kept: FittedScope[] = [];
  const leftOut: string[] = [];
  for (const s of scopes) {
    const size = layout.size(layout.index(s));
    if (s.where.scope === "table" && used + size > budget) {
      leftOut.push(leftOutItem(s, "all"));
      continue;
    }
    used += size;
    kept.push({ ...s, entries: [], omitted: s.entries.length });
  }
  // Pass 2: entries, in order, while they fit.
  let full = false;
  for (const k of kept) {
    const all = scopes.find((s) => s.where === k.where)!.entries;
    for (const e of all) {
      if (full) break;
      const size = layout.size(layout.entry(k, e));
      if (used + size > budget) {
        full = true;
        break;
      }
      used += size;
      k.entries.push(e);
      k.omitted--;
    }
  }
  for (const k of kept) if (k.omitted > 0) leftOut.push(leftOutItem(k, k.omitted));
  return { scopes: kept, leftOut: closingList(leftOut) };
}

/** The system prompt's memory block, each part with the blank line before it. */
export const PROMPT_LAYOUT: MemoryLayout = {
  head: [
    "# Memory",
    "What earlier Jobs and the owner kept for the Jobs that come next. Write to it with memory_add, memory_update and memory_remove when your instructions ask you to; it is not a log.",
  ].join("\n\n"),
  index: (s) =>
    [
      `\n\n## ${s.label}`,
      ...(s.entries.length ? [memoryIndex(s.entries)] : []),
      ...(s.withheld ? [`${s.withheld} ${s.withheld === 1 ? "entry" : "entries"} written by agents that don't configure the workspace, and not accepted by a person, left out here: read them with memory_read.`] : []),
    ].join("\n\n"),
  entry: (_s, e) => `\n\n### ${e.path}\n\n${e.body}`,
  closing: (leftOut) => (leftOut.length ? `\n\nMore memory, with memory_read: ${leftOut.join("; ")}.` : ""),
  size: (part) => part.length,
};

/** What a Job's system prompt gets of its memory, within `MEMORY_PROMPT_BUDGET`; empty when there is nothing. */
export function memoryPrompt(memory: JobMemory): string {
  return renderPrompt(memory, fitMemory(memory, MEMORY_PROMPT_BUDGET, PROMPT_LAYOUT));
}

function renderPrompt(memory: JobMemory, fitted: FittedMemory): string {
  if (fitted.scopes.length === 0 && fitted.leftOut.length === 0) return "";
  const parts = [PROMPT_LAYOUT.head];
  // The index lists every entry of the scope, kept or not: the index is always whole.
  for (const s of fitted.scopes) parts.push(PROMPT_LAYOUT.index(memory.scopes.find((m) => m.where === s.where)!));
  for (const s of fitted.scopes) for (const e of s.entries) parts.push(PROMPT_LAYOUT.entry(s, e));
  parts.push(PROMPT_LAYOUT.closing(fitted.leftOut));
  return parts.join("");
}

/**
 * A Job's memory block for its session start, in a `memory.prompt` span and counted: how many
 * scopes, entries sent, withheld and left out, never a path, a name or a body.
 */
export function jobMemoryPrompt(db: Db, run: RunRow): Promise<string> {
  return traces.startActiveSpan("memory.prompt", { attributes: { "dispand.job.id": run.id } }, async (span) => {
    let result = "error";
    try {
      const memory = await memoryForJob(db, run);
      const fitted = fitMemory(memory, MEMORY_PROMPT_BUDGET, PROMPT_LAYOUT);
      const sent = fitted.scopes.reduce((n, s) => n + s.entries.length, 0);
      span.setAttributes({
        "dispand.memory.scopes": fitted.scopes.length,
        "dispand.memory.entries": sent,
        "dispand.memory.withheld": memory.scopes.reduce((n, s) => n + s.withheld, 0),
        "dispand.memory.left_out": fitted.leftOut.length,
      });
      const text = renderPrompt(memory, fitted);
      result = text === "" ? "none" : fitted.leftOut.length ? "cut" : "whole";
      return text;
    } catch (err) {
      recordError(span, "error");
      throw err;
    } finally {
      span.setAttribute("dispand.result", result);
      prompts.add(1, { "dispand.result": result });
      span.end();
    }
  });
}
