import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { questions, runs, tools, type AnsweredBy } from "../db/schema.ts";
import { sessionTooling } from "../engine/tooling.ts";
import { meter, tracer } from "../telemetry/index.ts";
import { rememberAllowedAction, setPermission, toolPermissionTarget } from "./tool-ask.ts";

/** A server-resolved tool action, bound to the target for which permission was requested. */
export type Subject = { kind: "tool"; toolId: string; action: string; target: string };
export type RememberScope = "run" | "always";
export type RememberOffer = { scopes: RememberScope[]; subject: Subject };
export type RememberedPermissions = { allow: Subject[]; deny: Subject[] };
type Decision = "allow" | "deny";

const same = (a: Subject, b: Subject) => a.kind === b.kind && a.toolId === b.toolId && a.action === b.action && a.target === b.target;

/** A remembered decision never follows a tool to a different target or permission revision. */
export function rememberedDecision(state: RememberedPermissions, subject: Subject): Decision | null {
  if (state.deny.some((s) => same(s, subject))) return "deny";
  return state.allow.some((s) => same(s, subject)) ? "allow" : null;
}

const traces = tracer("permissions");
const remembered = meter("permissions").counter("dispand.permissions.remembered", { description: "Remembered permission decisions, by scope and result" });

type Input = { questionId: string; decision: Decision; scope: RememberScope; by: AnsweredBy };

/**
 * Store only the permission the server offered, while its question is still pending. The
 * question-answer transaction calls this before saving its answer; no request supplies a
 * subject, tool id or target. This storage layer is wired to answer delivery separately.
 */
export async function remember(db: Db | Tx, input: Input): Promise<boolean> {
  return traces.startActiveSpan("permission.remember", async (span) => {
    let result = "error";
    try {
      const written = await write(db, input);
      result = written ? "ok" : "refused";
      return written;
    } finally {
      const attributes = { "dispand.permission.scope": input.scope, "dispand.answer.decision": input.decision, "dispand.result": result };
      span.setAttributes(attributes);
      span.end();
      remembered.add(1, attributes);
    }
  });
}

async function write(db: Db | Tx, input: Input): Promise<boolean> {
  if (input.by.type !== "user") return false;
  const ownerId = input.by.userId;
  return db.transaction(async (tx) => {
    const [found] = await tx.select({ question: questions, run: runs }).from(questions).innerJoin(runs, eq(runs.id, questions.runId))
      .where(and(eq(questions.id, input.questionId), eq(questions.ownerId, ownerId), eq(runs.ownerId, ownerId))).for("update");
    if (!found) return false;
    const { question: q, run } = found;
    if (q.status !== "pending" || !["running", "waiting"].includes(run.status) || !q.remember?.scopes.includes(input.scope) || q.kind !== "approval" || q.payload.kind !== "permission" || !q.sessionId || q.proposalId || q.rootId || q.consultId || q.consultRunId || ["request_approval", "checkpoint", "consult"].includes(q.payload.toolName)) return false;
    const subject = q.remember.subject;
    const [tool] = await tx.select().from(tools).where(and(eq(tools.id, subject.toolId), eq(tools.ownerId, ownerId))).for("share");
    if (!tool || toolPermissionTarget(tool) !== subject.target) return false;
    const tooling = await sessionTooling(tx, q.sessionId);
    const current = [...tooling.runnerTools, ...tooling.httpTools].find((t) => t.id === subject.toolId);
    if (!current?.actions.some((a) => a.name === subject.action)) return false;
    if (input.scope === "always") {
      if (run.source !== "agent" || !run.agentId) return false;
      const to = { agentId: run.agentId, toolId: subject.toolId, action: subject.action };
      return input.decision === "allow" ? rememberAllowedAction(tx, ownerId, to) : setPermission(tx, ownerId, { ...to, permission: "off" });
    }
    const state = {
      allow: run.remembered.allow.filter((s) => !same(s, subject)),
      deny: run.remembered.deny.filter((s) => !same(s, subject)),
    };
    state[input.decision].push(subject);
    await tx.update(runs).set({ remembered: state }).where(eq(runs.id, run.id));
    return true;
  });
}
