import { z } from "zod";
import type { EventActor } from "../db/schema.ts";

// What an Audit row may hold (design 6.8). The structure is the redaction: an action is one of a
// closed list, and details are a strict object of ids, names, counts and kinds, so a row has no
// place for a value, a prompt, a message, an answer, a URL or an error's words.

/** Every action a row records. A new one goes here and in the Audit page's words in the same change. */
export const AUDIT_ACTIONS = [
  "job.created",
  "job.queued",
  "job.started",
  "job.reopened",
  "job.waiting",
  "job.finished",
  "job.failed",
  "job.skipped",
  "checkpoint.reached",
  "checkpoint.answered",
  "question.asked",
  "question.answered",
  "question.expired",
  "consult.asked",
  "consult.ended",
  "platform.call",
  "tool.call",
  "poll.run",
  "event.recorded",
  "memory.written",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** An action's family: what comes before its dot (`job` for `job.created`). */
export const AUDIT_FAMILIES = [...new Set(AUDIT_ACTIONS.map((a) => a.slice(0, a.indexOf("."))))] as [string, ...string[]];

/** What a row is about. */
export const AUDIT_RESOURCES = [
  "job",
  "root",
  "question",
  "consult",
  "tool",
  "trigger",
  "poll",
  "table",
  "row",
  "field",
  "agent",
  "harness",
  "proposal",
  "plugin",
  "memory",
  "workspace",
] as const;
export type AuditResource = (typeof AUDIT_RESOURCES)[number];

export const AUDIT_RESULTS = ["ok", "refused", "failed"] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

/** Who did it: a person, a Job, or the scheduler (a firing, a poll). A workflow step never writes a row. */
export type AuditActor = Exclude<EventActor, { type: "step" }> | { type: "scheduler" };

/** A server-made id (or a built-in kind used as one). */
export const AuditId = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
/** A name as it was then (an agent's, a tool's): cut at the cap by the writer. */
const id = AuditId;
const name = z.string();
/** A kind: a short code, never words. */
const kind = z.string().regex(/^[a-z0-9_.-]{1,64}$/);
const n = z.number().int().nonnegative();

/** The details a row may carry; any other key is refused. */
export const AuditDetails = z.strictObject({
  agentId: id,
  harnessId: id,
  runnerId: id,
  triggerId: id,
  rootId: id,
  questionId: id,
  consultedJobId: id,
  proposalId: id,
  toolId: id,
  tableId: id,
  rowId: id,
  eventId: id,
  memoryId: id,
  agentName: name,
  harnessName: name,
  runnerName: name,
  triggerName: name,
  toolName: name,
  tableName: name,
  causeKind: kind,
  firing: kind,
  questionKind: kind,
  decision: kind,
  answeredBy: kind,
  outcome: kind,
  reason: kind,
  operation: kind,
  scope: kind,
  status: kind,
  item: n,
  items: n,
  jobs: n,
  fields: n,
  events: n,
  found: n,
  /** A platform tool's name. */
  tool: kind,
  /** A tool's action name. */
  action: name,
}).partial();
export type AuditDetails = z.infer<typeof AuditDetails>;
