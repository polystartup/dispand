import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { agentTools, cloudSessions, questions, runs, stepRuns, tools, type AnsweredBy } from "../db/schema.ts";
import { mcpActionName, type QuestionPayload } from "@dispand/runner-protocol";
import { exposedName } from "../platform/exposed.ts";
import { runnerServerName, sessionTooling } from "../engine/tooling.ts";
import { meter, tracer } from "../telemetry/index.ts";
import { rememberAllowedAction, setPermission, toolPermissionTarget } from "./tool-ask.ts";

/** A server-resolved tool action, bound to the target for which permission was requested. */
export type Subject = { kind: "tool"; agentId: string; toolId: string; action: string; target: string };
export type RememberScope = "run" | "always";
export type RememberOffer = { scopes: RememberScope[]; subject: Subject };
export type RememberedPermissions = { allow: Subject[]; deny: Subject[] };
type Decision = "allow" | "deny";

const same = (a: Subject, b: Subject) => a.kind === b.kind && a.agentId === b.agentId && a.toolId === b.toolId && a.action === b.action && a.target === b.target;

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
    if (subject.agentId !== tooling.agentId) return false;
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


/** Resolve an offer from the active session's identities, never the runner's display label. */
export async function offerForQuestion(db: Db | Tx, input: { ownerId: string; sessionId: string; questionId: string; payload: QuestionPayload; harness?: string }): Promise<{ remember: RememberOffer; about: { tool: string; action: string; description: string; toolId: string } } | null> {
  if (input.payload.kind !== "permission" || ["request_approval", "checkpoint", "consult"].includes(input.payload.toolName)) return null;
  const [run] = await db.select({ source: runs.source, agentId: runs.agentId, status: runs.status }).from(stepRuns).innerJoin(runs, eq(runs.id, stepRuns.runId))
    .where(and(eq(stepRuns.sessionId, input.sessionId), eq(runs.ownerId, input.ownerId)));
  if (!run || !["running", "waiting"].includes(run.status)) return null;
  const tooling = await sessionTooling(db, input.sessionId);
  if (!tooling.agentId) return null;
  const [cloud] = await db.select({ pending: cloudSessions.pending }).from(cloudSessions).where(and(eq(cloudSessions.id, input.sessionId), eq(cloudSessions.ownerId, input.ownerId)));
  const cloudKey = cloud?.pending?.questionId === input.questionId ? cloud.pending.key : undefined;
  const named = input.payload.toolName;
  const candidates = [
    ...tooling.httpTools.flatMap((tool) => tool.actions.filter((a) => cloudKey === `tool:${tool.id}:${a.name}` || named === `mcp__job_tools__${exposedName(tool, a.name)}`).map((action) => ({ tool, action }))),
    ...tooling.runnerTools.flatMap((tool) => tool.actions.filter((a) => named === `mcp__${runnerServerName(tool)}__${mcpActionName(a.name, input.harness)}`).map((action) => ({ tool, action }))),
  ];
  if (candidates.length !== 1) return null;
  const { tool, action } = candidates[0]!;
  const [row] = await db.select().from(tools).where(and(eq(tools.id, tool.id), eq(tools.ownerId, input.ownerId)));
  if (!row) return null;
  const [chosen] = await db.select({ id: agentTools.toolId }).from(agentTools).where(and(eq(agentTools.agentId, tooling.agentId), eq(agentTools.toolId, tool.id)));
  return {
    remember: { scopes: run.source === "agent" && run.agentId === tooling.agentId && chosen ? ["run", "always"] : ["run"], subject: { kind: "tool", agentId: tooling.agentId, toolId: tool.id, action: action.name, target: toolPermissionTarget(row) } },
    about: { tool: row.name, toolId: row.id, action: action.name, description: action.description },
  };
}

/** Whether an undelivered positive answer still authorizes caching its permission. */
export async function toolAnswerPermission(db: Db, q: typeof questions.$inferSelect): Promise<"deny" | "once" | "remember"> {
  if (!q.remember || !q.sessionId) return "deny";
  const { subject } = q.remember;
  const [run] = await db.select({ status: runs.status }).from(runs).where(and(eq(runs.id, q.runId), eq(runs.ownerId, q.ownerId)));
  if (!run || !["running", "waiting"].includes(run.status)) return "deny";
  const [tool] = await db.select().from(tools).where(and(eq(tools.id, subject.toolId), eq(tools.ownerId, q.ownerId)));
  if (!tool || toolPermissionTarget(tool) !== subject.target) return "deny";
  const tooling = await sessionTooling(db, q.sessionId);
  const current = [...tooling.httpTools, ...tooling.runnerTools].find((t) => t.id === subject.toolId && t.actions.some((a) => a.name === subject.action));
  if (tooling.agentId !== subject.agentId || !current) return "deny";
  return current.unasked.includes(subject.action) ? "remember" : "once";
}
