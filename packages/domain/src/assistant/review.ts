import { and, asc, eq, gte, inArray, lt, ne } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { agents, questions, runs, tables, tools, triggers } from "../db/schema.ts";
import { errorKind } from "../log.ts";
import type { TableScope } from "../platform/bundles.ts";
import { inSpan, tracer } from "../telemetry/index.ts";
import { signInOf } from "../tools/catalog.ts";

// The Assistant's review of the workspace: what could be better, read from the workspace's rows
// alone (no model), so a review costs one Job and its findings are testable. The Assistant only
// proposes a change for each signal; the owner approves it, or not.

const traces = tracer("assistant");

const DAY = 86_400_000;
/** A Question waiting longer than this is a signal. */
export const STALE_QUESTION_DAYS = 3;
/** A button pressed at least `RECURRING_STARTS` times at the same hour within this many days could be a schedule. */
export const RECURRING_DAYS = 14;
export const RECURRING_STARTS = 4;
/** A signal whose proposal the owner declined within this many days isn't raised again. */
export const DECLINED_DAYS = 30;

export type ReviewSignal = { key: string } & (
  | { kind: "agent-without-trigger"; agentId: string; name: string }
  | { kind: "table-not-read"; tableId: string; name: string }
  | { kind: "tool-needs-sign-in"; toolId: string; name: string; signInPath: string }
  | { kind: "question-open"; questionId: string; runId: string; since: Date }
  | { kind: "recurring-button"; triggerId: string; agentId: string; name: string; starts: number; hour: number; timezone: string }
);

/** The hour of the day `at` is in `timezone`, 0 to 23. */
const hourIn = (timezone: string) => {
  const format = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "numeric", hourCycle: "h23" });
  return (at: Date) => Number(format.format(at));
};

/**
 * What the review finds in the owner's workspace, each signal with the ids it names and a `key`
 * that stands for it (its kind and its id): agents with no trigger; tables no agent but the
 * Assistant (which reads every one) works on; tools waiting for their owner to sign in;
 * Questions and Approvals open more than three days; a button started at least four times in two
 * weeks within one hour of the day in `timezone`. A signal is left out when an Approval of the
 * Assistant's that names its key was denied in the last 30 days: the owner said no to it.
 */
export async function reviewSignals(db: Db, ownerId: string, now: Date, timezone: string): Promise<ReviewSignal[]> {
  return inSpan(traces, "assistant.review", {}, errorKind, async (span) => {
    const [ownAgents, ownTables, ownTools, ownTriggers, stale, declined] = await Promise.all([
      db.select({ id: agents.id, name: agents.name, bundles: agents.bundles, dataTables: agents.dataTables, builtIn: agents.builtIn }).from(agents).where(eq(agents.ownerId, ownerId)).orderBy(asc(agents.name), asc(agents.id)),
      db.select({ id: tables.id, name: tables.name }).from(tables).where(eq(tables.ownerId, ownerId)).orderBy(asc(tables.name), asc(tables.id)),
      db.select().from(tools).where(eq(tools.ownerId, ownerId)).orderBy(asc(tools.name), asc(tools.id)),
      db.select({ id: triggers.id, agentId: triggers.agentId, name: triggers.name, config: triggers.config }).from(triggers).where(eq(triggers.ownerId, ownerId)),
      db
        .select({ id: questions.id, runId: questions.runId, createdAt: questions.createdAt })
        .from(questions)
        // A consult asks no person: it is no Inbox item.
        .where(and(eq(questions.ownerId, ownerId), eq(questions.status, "pending"), ne(questions.kind, "consult"), lt(questions.createdAt, new Date(now.getTime() - STALE_QUESTION_DAYS * DAY))))
        .orderBy(asc(questions.createdAt), asc(questions.id)),
      db
        .select({ payload: questions.payload, answer: questions.answer })
        .from(questions)
        .innerJoin(runs, eq(runs.id, questions.runId))
        .innerJoin(agents, eq(agents.id, runs.agentId))
        .where(
          and(
            eq(questions.ownerId, ownerId),
            eq(agents.builtIn, "assistant"),
            eq(questions.kind, "approval"),
            eq(questions.status, "answered"),
            gte(questions.answeredAt, new Date(now.getTime() - DECLINED_DAYS * DAY)),
          ),
        ),
    ]);
    const signals: ReviewSignal[] = [];
    // The Assistant has its chat, so it is never without a trigger.
    const triggered = new Set(ownTriggers.map((t) => t.agentId));
    for (const a of ownAgents) if (!triggered.has(a.id)) signals.push({ key: `agent-without-trigger:${a.id}`, kind: "agent-without-trigger", agentId: a.id, name: a.name });
    const readers = ownAgents.filter((a) => a.builtIn !== "assistant" && a.bundles.includes("data"));
    const reads = (scope: TableScope, tableId: string) => scope === "all" || scope.includes(tableId);
    for (const t of ownTables) if (!readers.some((a) => reads(a.dataTables, t.id))) signals.push({ key: `table-not-read:${t.id}`, kind: "table-not-read", tableId: t.id, name: t.name });
    for (const t of ownTools) {
      if (signInOf(t) === "needed") signals.push({ key: `tool-needs-sign-in:${t.id}`, kind: "tool-needs-sign-in", toolId: t.id, name: t.name, signInPath: `/settings/tools?tool=${encodeURIComponent(t.id)}` });
    }
    for (const q of stale) signals.push({ key: `question-open:${q.id}`, kind: "question-open", questionId: q.id, runId: q.runId, since: q.createdAt });
    signals.push(...(await recurringButtons(db, ownerId, ownTriggers, now, timezone)));

    const denied = declined.filter((q) => q.answer?.kind === "permission" && q.answer.decision === "deny").map((q) => JSON.stringify(q.payload));
    const kept = signals.filter((s) => !denied.some((text) => text.includes(s.key)));
    span.setAttributes({ "dispand.review.signals": kept.length, "dispand.review.declined": signals.length - kept.length });
    return kept;
  });
}

/** Buttons whose Jobs of the last two weeks started at least four times within one hour of the day. */
async function recurringButtons(db: Db, ownerId: string, ownTriggers: { id: string; agentId: string; name: string; config: { kind: string; placement?: string } }[], now: Date, timezone: string): Promise<ReviewSignal[]> {
  const buttons = ownTriggers.filter((t) => t.config.kind === "manual" && t.config.placement === "button");
  if (buttons.length === 0) return [];
  const started = await db
    .select({ triggerId: runs.triggerId, createdAt: runs.createdAt })
    .from(runs)
    .where(and(eq(runs.ownerId, ownerId), eq(runs.source, "agent"), inArray(runs.triggerId, buttons.map((b) => b.id)), gte(runs.createdAt, new Date(now.getTime() - RECURRING_DAYS * DAY))));
  const hour = hourIn(timezone);
  const signals: ReviewSignal[] = [];
  for (const b of buttons) {
    const byHour = new Map<number, number>();
    for (const r of started) if (r.triggerId === b.id) byHour.set(hour(r.createdAt), (byHour.get(hour(r.createdAt)) ?? 0) + 1);
    const [top] = [...byHour].sort(([h1, n1], [h2, n2]) => n2 - n1 || h1 - h2);
    if (top && top[1] >= RECURRING_STARTS) signals.push({ key: `recurring-button:${b.id}`, kind: "recurring-button", triggerId: b.id, agentId: b.agentId, name: b.name, starts: top[1], hour: top[0], timezone });
  }
  return signals;
}

/** A review's signals within a Job's tables: a table it may not work on isn't named to it. */
export function signalsWithin(output: unknown, scope: TableScope): unknown {
  if (scope === "all") return output;
  return (output as ReviewSignal[]).filter((s) => s.kind !== "table-not-read" || scope.includes(s.tableId));
}
