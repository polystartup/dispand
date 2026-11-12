import { isMemoryPath, MAX_MEMORY_PATH_LENGTH } from "@dispand/runner-protocol";
import { z } from "zod";

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

export type MemoryScope = { scope: "workspace" } | { scope: "table"; tableId: string } | { scope: "agent"; agentId: string };

/** Who wrote a revision: a person, or a Job (its agent and run, and whether it had `configure`). */
export type MemoryAuthor = { type: "user" } | { type: "agent"; agentId: string; runId: string; configure: boolean };

export const PATH_RULE =
  "The path must be a relative path ending in .md, at most 120 characters, without .., . or empty parts, \\ or a .claude or .mcp.json folder, and not MEMORY.md, CLAUDE.md, AGENTS.md or AGENTS.override.md.";

/** An entry as written; every writer checks it with this schema, so a refusal reads the same whoever wrote. */
export const MemoryEntryInput = z.object({
  path: z.string().refine(isMemoryPath, PATH_RULE),
  name: z.string().trim().min(1, "The name can't be empty.").max(MAX_MEMORY_NAME, `The name is at most ${MAX_MEMORY_NAME} characters.`),
  description: z
    .string()
    .trim()
    .min(1, "The description can't be empty.")
    .max(MAX_MEMORY_DESCRIPTION, `The description is at most ${MAX_MEMORY_DESCRIPTION} characters.`)
    .refine((d) => !/[\r\n]/.test(d), "The description is one line."),
  type: z.enum(MEMORY_TYPES, `The type is one of ${MEMORY_TYPES.join(", ")}.`),
  body: z.string().max(MAX_MEMORY_BODY, `The body is at most ${MAX_MEMORY_BODY} characters.`),
});
export type MemoryEntryFields = z.infer<typeof MemoryEntryInput>;
