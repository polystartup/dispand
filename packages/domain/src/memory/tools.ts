import { ID as MAX_ID } from "@dispand/runner-protocol";
import { z } from "zod";
import type { JobIdentity, PlatformApp, ToolResult } from "../platform/call.ts";
import type { Rights } from "../platform/rights.ts";
import { meter, recordError, tracer } from "../telemetry/index.ts";
import { MEMORY_TYPES, type MemoryAuthor, MemoryEntryShape, type MemoryScope, type MemoryTarget } from "./model.ts";
import { listMemory, type MemoryEntry, memoryIndex, NOT_FOUND, refuseWrite, removeMemory, scopeExists, writeMemory } from "./store.ts";

// The agents' memory tools (design 6.5): `memory_read` for every Job, `memory_add`,
// `memory_update` and `memory_remove` within the Job's self-learning targets. The tables a call
// names are checked by `callPlatformTool` before these run (one outside the Job's tables is "Not
// found"); the rest of the scope's rule is here, against the Job's rights as they are now.

const traces = tracer("memory");
const reads = meter("memory").counter("dispand.memory.reads", { description: "Memory reads by Jobs, by scope and result" });

const ID = z.string().min(1).max(MAX_ID);
const SCOPE = z.enum(["workspace", "agent", "table"]).describe("workspace: the workspace's memory; agent: your own agent's; table: a Data table's, named by tableId.");
const TABLE_ID = ID.optional().describe("The table, for the table scope.");

export const ReadInput = z.object({
  scope: SCOPE,
  tableId: TABLE_ID,
  agentId: ID.optional().describe("Another agent's memory, for the agent scope: only an agent that configures the workspace reads it."),
  path: z.string().max(1000).optional().describe("An entry's path; without it, the scope's index."),
});
export const WriteInput = z.object({
  scope: SCOPE,
  tableId: TABLE_ID,
  ...MemoryEntryShape,
  path: MemoryEntryShape.path.describe("Where the entry is, unique in its memory: a relative path ending in .md, at most 120 characters (`clients/acme.md`)."),
  name: MemoryEntryShape.name.describe("Its name, at most 60 characters."),
  description: MemoryEntryShape.description.describe("What it is about, on one line of at most 150 characters: the index shows it."),
  type: MemoryEntryShape.type.describe(`One of ${MEMORY_TYPES.join(", ")}: how the business works, how a kind of work is done, a fact, where something is found.`),
  body: MemoryEntryShape.body.describe("The fact itself, at most 8,000 characters."),
});
export const RemoveInput = z.object({ scope: SCOPE, tableId: TABLE_ID, path: z.string().max(1000) });

type Read = z.infer<typeof ReadInput>;
type Write = z.infer<typeof WriteInput>;
type Remove = z.infer<typeof RemoveInput>;

const NO_TABLE = "The table scope needs a tableId.";

/** The table a call names, for `callPlatformTool`'s check of the Job's tables. */
export function tablesOf(input: unknown): string[] {
  const { scope, tableId } = (input ?? {}) as { scope?: unknown; tableId?: unknown };
  return scope === "table" && typeof tableId === "string" ? [tableId] : [];
}

/** What the agent reads of an entry's author: a person, or a Job of an agent and whether it configured the workspace. */
const authorView = (a: MemoryAuthor) => (a.type === "user" ? { type: "person" as const } : { type: "agent" as const, agentId: a.agentId, jobId: a.runId, configure: a.configure });

/** `memory_read`: the workspace's, the Job's own agent's, its tables' with `data`, any agent's with `configure`. */
export function readMemory(app: PlatformApp, job: JobIdentity, input: Read, rights: Rights): Promise<ToolResult> {
  return traces.startActiveSpan("memory.read", { attributes: { "dispand.job.id": job.runId, "dispand.memory.scope": input.scope } }, async (span) => {
    let result = "error";
    try {
      const out = await read(app, job, input, rights);
      result = out.ok ? "ok" : out.error === NOT_FOUND ? "not-found" : "refused";
      if (!out.ok) recordError(span, result);
      return out;
    } finally {
      span.setAttribute("dispand.result", result);
      reads.add(1, { "dispand.memory.scope": input.scope, "dispand.result": result });
      span.end();
    }
  });
}

async function read(app: PlatformApp, job: JobIdentity, input: Read, rights: Rights): Promise<ToolResult> {
  let where: MemoryScope;
  if (input.scope === "workspace") where = { scope: "workspace" };
  else if (input.scope === "table") {
    if (!input.tableId) return { ok: false, error: NO_TABLE };
    // A table's memory is read with its rows: the Job's tables (checked before) and `data`.
    if (!rights.bundles.includes("data")) return { ok: false, error: NOT_FOUND };
    where = { scope: "table", tableId: input.tableId };
  } else {
    const agentId = input.agentId ?? job.agentId;
    if (agentId !== job.agentId && !rights.bundles.includes("configure")) return { ok: false, error: NOT_FOUND };
    where = { scope: "agent", agentId };
  }
  if (!(await scopeExists(app.db, job.ownerId, where))) return { ok: false, error: NOT_FOUND };
  const entries = await listMemory(app.db, job.ownerId, where);
  if (input.path === undefined) return { ok: true, output: { entries: entries.length, index: memoryIndex(entries) } };
  const entry = entries.find((e) => e.path === input.path);
  if (!entry) return { ok: false, error: `There is no entry ${input.path}.` };
  return { ok: true, output: view(entry) };
}

/** An entry as the agent reads it: accepted when a person wrote it or accepted it since. */
const view = (e: MemoryEntry) => ({
  path: e.path,
  name: e.name,
  description: e.description,
  type: e.type,
  body: e.body,
  author: authorView(e.author),
  accepted: e.author.type === "user" || e.acceptedAt !== null,
  updatedAt: e.updatedAt,
});

const TARGET_OF = { workspace: "workspace", agent: "agent", table: "data" } as const satisfies Record<MemoryScope["scope"], MemoryTarget>;
const MEMORY_OF = { workspace: "the workspace's memory", agent: "its own memory", table: "a table's memory" } as const;

/** Where a write lands, or why the Job may not write there: the scope's target, and `data` for a table. */
function writable(job: JobIdentity, input: { scope: MemoryScope["scope"]; tableId?: string | undefined }, rights: Rights): MemoryScope | string {
  const target = TARGET_OF[input.scope];
  if (!rights.selfLearning.includes(target)) return `This agent may not write ${MEMORY_OF[input.scope]}: its self-learning doesn't include ${target}.`;
  if (input.scope === "workspace") return { scope: "workspace" };
  if (input.scope === "agent") return { scope: "agent", agentId: job.agentId };
  if (!input.tableId) return NO_TABLE;
  if (!rights.bundles.includes("data")) return "This agent may not write a table's memory: it doesn't work on data.";
  return { scope: "table", tableId: input.tableId };
}

/** The Job that writes: its agent, its run and whether it configures the workspace. */
const authorOf = (job: JobIdentity, rights: Rights): MemoryAuthor => ({ type: "agent", agentId: job.agentId, runId: job.runId, configure: rights.bundles.includes("configure") });

/** `memory_add` (a path that has no entry) and `memory_update` (one that has). */
export async function writeMemoryTool(app: PlatformApp, job: JobIdentity, input: Write, rights: Rights, mode: "add" | "update"): Promise<ToolResult> {
  const where = writable(job, input, rights);
  const entry = { path: input.path, name: input.name, description: input.description, type: input.type, body: input.body };
  const done = typeof where === "string" ? await refuseWrite(input.scope, mode, where) : await writeMemory(app.db, job.ownerId, where, entry, authorOf(job, rights), mode);
  return "error" in done ? { ok: false, error: done.error } : { ok: true, output: { path: entry.path } };
}

/** `memory_remove`: the live entry at a path; it can be restored by the owner. */
export async function removeMemoryTool(app: PlatformApp, job: JobIdentity, input: Remove, rights: Rights): Promise<ToolResult> {
  const where = writable(job, input, rights);
  if (typeof where === "string") return { ok: false, error: (await refuseWrite(input.scope, "remove", where)).error };
  if (await removeMemory(app.db, job.ownerId, where, input.path, authorOf(job, rights))) return { ok: true, output: { path: input.path, removed: true } };
  return { ok: false, error: (await refuseWrite(input.scope, "remove", `There is no entry ${input.path}.`)).error };
}
