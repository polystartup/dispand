import { z } from "zod";
import { StorableText } from "../text.ts";

// Pure: what a trigger is, for the procedures, the engine and the web app.

export const TriggerConfig = z.discriminatedUnion("kind", [
  /** Started by the owner: a conversation with the agent, or a button. */
  z.object({ kind: z.literal("manual"), placement: z.enum(["chat", "button"]) }),
  /** Fired by the scheduler, with the rules of workflow schedules. */
  z.object({ kind: z.literal("schedule"), cron: z.string().max(100), timezone: z.string().max(100) }),
  /** Fired by a write of a row of a primitive table: these operations, and for updates, a change to one of `fields` (any field when absent). */
  z.object({
    kind: z.literal("primitive"),
    tableId: z.string().max(100),
    operations: z.array(z.enum(["created", "updated", "deleted"])).min(1).max(3),
    fields: z.array(z.string().max(100)).min(1).max(100).optional(),
  }),
]);
export type TriggerConfig = z.infer<typeof TriggerConfig>;

/** `one-at-a-time`: a schedule firing while a Job of the trigger is active is skipped. */
export const Concurrency = z.enum(["parallel", "one-at-a-time"]);

export const RateCap = z.number().int().min(1).max(1000);

export const TriggerFields = z.object({
  name: StorableText(100).trim().min(1),
  /** Added to the Job's prompt for this trigger. */
  instructions: StorableText(100_000).default(""),
  concurrency: Concurrency.default("parallel"),
  /** A primitive trigger's most Jobs in an hour; past it, events wait their turn. */
  rateCap: RateCap.default(60),
  config: TriggerConfig,
});
