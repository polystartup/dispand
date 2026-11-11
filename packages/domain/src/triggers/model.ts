import { z } from "zod";
import { StorableText } from "../text.ts";

// Pure: what a trigger is, for the procedures, the engine and the web app.

/** A poll's arguments as JSON, at most: well inside a runner message once `{{lastPoll}}` is filled. */
export const MAX_POLL_ARGUMENTS = 16 * 1024;

/** The built-in primitive of Questions and Approvals (design 6.3): an `events` row's table, and what a primitive trigger may watch in place of a table. */
export const INTERACTION = "interaction";
export const INTERACTION_OPERATIONS = ["created", "answered", "expired"] as const;
export const ROW_OPERATIONS = ["created", "updated", "deleted"] as const;

export const TriggerConfig = z.discriminatedUnion("kind", [
  /** Started by the owner: a conversation with the agent, or a button. */
  z.object({ kind: z.literal("manual"), placement: z.enum(["chat", "button"]) }),
  /** Fired by the scheduler, with the rules of workflow schedules. */
  z.object({ kind: z.literal("schedule"), cron: z.string().max(100), timezone: z.string().max(100) }),
  /**
   * Fired by a write of a row of a primitive table: these operations, and for updates, a change
   * to one of `fields` (any field when absent). Or, with `tableId` the built-in `interaction`, by
   * a Question or an Approval asked, answered or expired (no fields).
   */
  z
    .object({
      kind: z.literal("primitive"),
      tableId: z.string().max(100),
      operations: z.array(z.enum(["created", "updated", "deleted", "answered", "expired"])).min(1).max(3),
      fields: z.array(z.string().max(100)).min(1).max(100).optional(),
    })
    .refine((c) => c.operations.every((o) => (c.tableId === INTERACTION ? INTERACTION_OPERATIONS : ROW_OPERATIONS).includes(o as never)), {
      message: "These changes aren't ones of what the trigger watches",
      path: ["operations"],
    })
    .refine((c) => c.tableId !== INTERACTION || !c.fields, { message: "A Question or an Approval has no fields", path: ["fields"] }),
  /**
   * Fired by a poll: every `interval` seconds the scheduler calls `action` of the tool with
   * `arguments` (where `{{lastPoll}}` stands for the time the newest recorded item was found),
   * takes the list at `itemsPath` of its result (dots between keys; empty: the result itself) and
   * starts a Job for each item whose `idPath` it hasn't seen.
   */
  z.object({
    kind: z.literal("poll"),
    toolId: z.string().max(100),
    action: z.string().min(1).max(200),
    arguments: z.record(z.string().max(200), z.unknown()).refine((a) => JSON.stringify(a).length <= MAX_POLL_ARGUMENTS, "The arguments are larger than 16 KiB").default({}),
    itemsPath: z.string().trim().max(200).default(""),
    idPath: z.string().trim().min(1).max(200),
    interval: z.number().int().min(60).max(86_400).default(300),
  }),
]);
export type TriggerConfig = z.infer<typeof TriggerConfig>;

/** A JSON value as text with its object keys sorted: equal for configs the database stored in another key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === "object" && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}

/** `one-at-a-time`: a schedule firing while a Job of the trigger is active is skipped. */
export const Concurrency = z.enum(["parallel", "one-at-a-time"]);

export const RateCap = z.number().int().min(1).max(1000);

export const TriggerFields = z.object({
  name: StorableText(100).trim().min(1),
  /** Added to the Job's prompt for this trigger. */
  instructions: StorableText(100_000).default(""),
  concurrency: Concurrency.default("parallel"),
  /** A primitive or poll trigger's most Jobs in an hour; past it, events and items wait their turn. */
  rateCap: RateCap.default(60),
  config: TriggerConfig,
});
