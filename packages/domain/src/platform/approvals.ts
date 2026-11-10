import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { questions, runs } from "../db/schema.ts";
import type { JobIdentity } from "./call.ts";

// Approvals an endpoint can act on. A CLI session asks the owner before it calls a tool; the
// question and its answer are rows of `questions`. A server-side call that must have been
// approved looks its approval up here and uses it up: the server reads its own record of the
// owner's "yes", for those exact arguments, once.

/** `value` as JSON text with every object's keys sorted: equal content gives equal text, whatever the key order. */
export function canonical(value: unknown): string {
  const sorted = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, sorted((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sorted(value)) ?? "null";
}

/**
 * Uses up one approval of the Job for `toolName` called with `input`: a question of the Job's
 * run, still going, that asked permission for that tool with the same input (key order aside),
 * was answered with an allowance, and wasn't used yet. An "always allow" answer counts once,
 * like an allowance. False when there is none: the call was not approved, or not with these
 * arguments.
 */
export async function takeApproval(db: Db, job: JobIdentity, toolName: string, input: unknown): Promise<boolean> {
  const candidates = await db
    .select({ id: questions.id, payload: questions.payload, answer: questions.answer })
    .from(questions)
    .innerJoin(runs, eq(runs.id, questions.runId))
    .where(
      and(
        eq(questions.runId, job.runId),
        eq(questions.ownerId, job.ownerId),
        eq(runs.ownerId, job.ownerId),
        eq(runs.agentId, job.agentId),
        eq(runs.source, "agent"),
        inArray(runs.status, ["running", "waiting"]),
        eq(questions.kind, "approval"),
        eq(questions.status, "answered"),
        isNull(questions.consumedAt),
      ),
    )
    .orderBy(desc(questions.answeredAt), desc(questions.id));
  const wanted = canonical(input);
  for (const q of candidates) {
    if (q.payload.kind !== "permission" || q.payload.toolName !== toolName) continue;
    if (q.answer?.kind !== "permission" || q.answer.decision === "deny") continue;
    if (canonical(q.payload.input) !== wanted) continue;
    // Atomic: of two calls that found the same approval, one takes it.
    const [taken] = await db
      .update(questions)
      .set({ consumedAt: new Date() })
      .where(and(eq(questions.id, q.id), isNull(questions.consumedAt)))
      .returning({ id: questions.id });
    if (taken) return true;
  }
  return false;
}
