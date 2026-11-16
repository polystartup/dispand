import { isMemoryPath, MAX_MEMORY_PATH_LENGTH } from "@dispand/runner-protocol";
import { z } from "zod";
import { english, type MessageKey } from "../messages/index.ts";

// Memory (design 6.5): the workspace, each Data table and each agent keep entries, one fact
// each, with a name, a one-line description and a type; the index is made from them. Pure: what
// an entry is and its bounds, the same for the owner's procedures and the agents' tools.

/** What an entry is about; the index groups entries by it, in this order. */
export const MEMORY_TYPES = ["business", "practice", "fact", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** How the index heads each type's group. */
export const MEMORY_TYPE_LABELS: Record<MemoryType, string> = {
  business: "How the business works",
  practice: "How work is done",
  fact: "Facts",
  reference: "Where things are",
};

export const MAX_MEMORY_NAME = 60;
export const MAX_MEMORY_DESCRIPTION = 150;
export const MAX_MEMORY_BODY = 8000;
export { MAX_MEMORY_PATH_LENGTH };
/** Entries one scope holds at most (removed ones aside), so its index stays under 35,000 characters. */
export const MAX_MEMORY_ENTRIES = 100;

/**
 * Where an agent's Jobs may write memory (its self-learning switch): its own memory, the memory of
 * the tables it works on, the workspace's. Empty: it learns nothing.
 */
export const MEMORY_TARGETS = ["agent", "data", "workspace"] as const;
export type MemoryTarget = (typeof MEMORY_TARGETS)[number];

export type MemoryScope = { scope: "workspace" } | { scope: "table"; tableId: string } | { scope: "agent"; agentId: string };

/** Who wrote a revision: a person, or a Job (its agent and run, and whether it had `configure`). */
export type MemoryAuthor = { type: "user" } | { type: "agent"; agentId: string; runId: string; configure: boolean };

export const PATH_RULE = english("memory.entry.pathRule");

/** The values of the entry's refusals (`memory.entry.*`), whichever field they are about. */
export const ENTRY_VALUES = { nameMax: MAX_MEMORY_NAME, descriptionMax: MAX_MEMORY_DESCRIPTION, bodyMax: MAX_MEMORY_BODY, types: MEMORY_TYPES.join(", ") };

/** A refusal's message key as the schema's message: the store says it in English to agents and in a message to a person. */
const key = (k: MessageKey): string => k;

/** An entry as written; every writer checks it with this schema, so a refusal reads the same whoever wrote. */
export const MemoryEntryInput = z.object({
  path: z.string().refine(isMemoryPath, key("memory.entry.pathRule")),
  name: z.string().trim().min(1, key("memory.entry.nameEmpty")).max(MAX_MEMORY_NAME, key("memory.entry.nameTooLong")),
  description: z
    .string()
    .trim()
    .min(1, key("memory.entry.descriptionEmpty"))
    .max(MAX_MEMORY_DESCRIPTION, key("memory.entry.descriptionTooLong"))
    .refine((d) => !/[\r\n]/.test(d), key("memory.entry.descriptionOneLine")),
  type: z.enum(MEMORY_TYPES, key("memory.entry.typeOneOf")),
  body: z.string().max(MAX_MEMORY_BODY, key("memory.entry.bodyTooLong")),
});
export type MemoryEntryFields = z.infer<typeof MemoryEntryInput>;

/**
 * The fields' types and coarse bounds, for a procedure's or a tool's input: the entry's own rule
 * (`MemoryEntryInput`) is the store's, so a refusal reads the same for a person and an agent.
 */
export const MemoryEntryShape = {
  path: z.string().max(1000),
  name: z.string().max(1000),
  description: z.string().max(1000),
  type: z.string().max(100),
  body: z.string().max(MAX_MEMORY_BODY * 2),
};
