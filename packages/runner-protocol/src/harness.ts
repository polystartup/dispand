import { z } from "zod";
import { id, json, PERMISSION_INPUT, record, short, text } from "./bounds.ts";

/** A value the agent must hand back with `submit_outputs`. */
export const OutputField = z.object({
  // A plain identifier, never one an object's own prototype machinery answers to.
  name: id()
    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
    .refine((n) => !["__proto__", "constructor", "prototype"].includes(n), "reserved name"),
  description: short().optional(),
  type: z.literal("string"),
});
export type OutputField = z.infer<typeof OutputField>;

/** What the agent asks the owner. */
export const QuestionPayload = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("choice"),
    questions: z
      .array(
        z.object({
          question: short(),
          header: short(),
          options: z.array(z.object({ label: short(), description: short().optional() })).max(50),
          multiSelect: z.boolean(),
        }),
      )
      .max(20),
  }),
  z.object({
    kind: z.literal("permission"),
    toolName: id(),
    input: json(PERMISSION_INPUT),
    canAlwaysAllow: z.boolean(),
  }),
  z.object({
    kind: z.literal("confirm-outputs"),
    values: record(text(), 100),
  }),
]);
export type QuestionPayload = z.infer<typeof QuestionPayload>;

/** The owner's answer to a question, of the same kind. */
export const Answer = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("choice"),
    // Keyed by question text, so keys take the question's own limit.
    answers: record(z.union([short(), z.array(short()).max(50)]), 20, short()),
  }),
  z.object({
    kind: z.literal("permission"),
    decision: z.enum(["allow", "allow-always", "deny"]),
    message: short().optional(),
  }),
  z.object({
    kind: z.literal("confirm-outputs"),
    confirmed: z.boolean(),
    feedback: text().optional(),
  }),
]);
export type Answer = z.infer<typeof Answer>;

/** `error` messages the runner sends about the session itself rather than its work. */
export const SESSION_NOT_RUNNING = "the session is not running on this runner";
export const SESSION_ALREADY_RUNNING = "the session is already running";

/** What a harness session reports while it runs. */
export const HarnessEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cli-session"), cliSessionId: id() }),
  z.object({ type: z.literal("text"), delta: text() }),
  z.object({ type: z.literal("tool"), name: id(), status: z.enum(["started", "done"]) }),
  z.object({ type: z.literal("question"), questionId: id(), payload: QuestionPayload }),
  z.object({ type: z.literal("turn-end") }),
  z.object({ type: z.literal("outputs-accepted"), values: record(text(), 100) }),
  z.object({ type: z.literal("result"), text: text() }),
  z.object({ type: z.literal("error"), message: short() }),
]);
export type HarnessEvent = z.infer<typeof HarnessEvent>;
