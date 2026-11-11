import { storable } from "@dispand/runner-protocol";
import type { tools as toolsTable } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { type RunnerHub, RunnerRequestFailed } from "../runners/hub.ts";
import type { InstalledTools } from "./executor.ts";

// A poll trigger's call (design 6.7): one action of a tool, outside any Job, and the items of its result.

type ToolRow = typeof toolsTable.$inferSelect;

/** A poll's call, from start to answer, at most (the scheduler waits for its polls). */
export const POLL_TIMEOUT_MS = 60_000;
/** Items one poll takes from a result; the rest wait for the next poll. */
export const MAX_POLL_ITEMS = 500;
/** An item's content as JSON, at most: a larger one is recorded, refused, and starts nothing. */
export const MAX_ITEM_BYTES = 256 * 1024;
const MAX_ITEM_ID = 500;

/** What a poll's call came to: the result's data, or a short reason made here or by the runner. */
export type PollCall = { ok: true; data: unknown } | { ok: false; error: string };

/** Calls a tool's action for a poll, however the tool is reached. */
export type PollCaller = { call(tool: ToolRow, action: string, args: Record<string, unknown>): Promise<PollCall> };

/** Where no connector is configured: every poll fails, nothing is called. */
export const noPolls: PollCaller = { call: async () => ({ ok: false, error: "Polls can't run here: no tool connector is configured" }) };

function parse(text: string): PollCall {
  try {
    return { ok: true, data: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "The action's result isn't JSON" };
  }
}

/**
 * Polls over `installed` (an HTTP tool, through the connector: its address guard, its redaction)
 * and `hub` (a runner tool, through `tool.call`, which the runner checks itself). The data is the
 * result's structured content, else its text read as JSON.
 */
export function pollCaller(installed: InstalledTools, hub: Pick<RunnerHub, "call">): PollCaller {
  return {
    async call(tool, action, args) {
      if (tool.kind === "runner") {
        if (!tool.runnerId || !tool.runnerTool) return { ok: false, error: "The tool isn't on a runner yet" };
        try {
          const reply = await hub.call(tool.runnerId, { type: "tool.call", requestId: newId("req"), tool: tool.runnerTool, action, arguments: args }, POLL_TIMEOUT_MS);
          if (reply.error !== undefined) return { ok: false, error: reply.error };
          if (reply.isError) return { ok: false, error: "The action reported an error" };
          const text = (reply.content ?? []).find((c) => c.type === "text" && typeof c.text === "string");
          return text ? parse(text.text as string) : { ok: false, error: "The action's result has no text" };
        } catch (error) {
          if (!(error instanceof RunnerRequestFailed)) throw error;
          return { ok: false, error: error.message === "timed out" ? "The runner didn't answer in time" : "runner offline" };
        }
      }
      const called = await installed.call(tool, action, args, AbortSignal.timeout(POLL_TIMEOUT_MS));
      if (!called.ok) return called;
      if (called.result.isError) return { ok: false, error: "The action reported an error" };
      return called.result.structured ? { ok: true, data: called.result.structured } : parse(called.result.text);
    },
  };
}

/** `{{lastPoll}}` in each string of the arguments (keys left as they are) becomes `lastPoll`. */
export function fillLastPoll(value: unknown, lastPoll: string): unknown {
  if (typeof value === "string") return value.replaceAll("{{lastPoll}}", lastPoll);
  if (Array.isArray(value)) return value.map((v) => fillLastPoll(v, lastPoll));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillLastPoll(v, lastPoll)]));
  return value;
}

/** The value at `path` (keys between dots; a number indexes a list), `value` itself for an empty path. */
function at(value: unknown, path: string): unknown {
  if (!path) return value;
  let here = value;
  for (const key of path.split(".")) {
    if (typeof here !== "object" || here === null || !Object.hasOwn(here, key)) return undefined;
    here = (here as Record<string, unknown>)[key];
  }
  return here;
}

export type PolledItem = { id: string; content: string; tooLarge: boolean };

/**
 * The items of a result: the list at `itemsPath`, each with its id (a string or a number at
 * `idPath`) and its content as JSON. Items without an id are counted, not kept; past
 * `MAX_POLL_ITEMS`, the rest wait for the next poll; an id seen twice is kept once.
 */
export function itemsOf(data: unknown, itemsPath: string, idPath: string): { items: PolledItem[]; noId: number } | { error: string } {
  const list = at(data, itemsPath);
  if (!Array.isArray(list)) return { error: itemsPath ? `The result has no list at “${itemsPath}”` : "The result isn't a list" };
  const items: PolledItem[] = [];
  const seen = new Set<string>();
  let noId = 0;
  for (const item of list) {
    if (items.length === MAX_POLL_ITEMS) break;
    const raw = at(item, idPath);
    const id = typeof raw === "string" ? raw : typeof raw === "number" && Number.isFinite(raw) ? String(raw) : "";
    if (!id || id.length > MAX_ITEM_ID || !storable(id)) {
      noId++;
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    // JSON escapes NUL and lone surrogates: the text is storable as it is.
    const content = JSON.stringify(item);
    items.push(content.length > MAX_ITEM_BYTES ? { id, content: "", tooLarge: true } : { id, content, tooLarge: false });
  }
  return { items, noId };
}
