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
  "job.grantIssued",
  "job.paused",
  "job.turn",
  "job.turnInterrupt",
  "job.reopened",
  "job.waiting",
  "job.finished",
  "job.failed",
  "job.skipped",
  "checkpoint.reached",
  "checkpoint.answered",
  "question.asked",
  "question.answered",
  "question.awaitingConsent",
  "question.consented",
  "question.expired",
  "question.refused",
  "question.rerouted",
  "question.unanswered",
  "consult.asked",
  "consult.ended",
  "platform.call",
  "tool.call",
  "poll.run",
  "event.recorded",
  "memory.written",
  "plugin.decided",
  "workspace.created",
  "workspace.renamed",
  "workspace.runnerRegistered",
  "workspace.runnerRevoked",
  "workspace.subscriptionEnrolled",
  "workspace.subscriptionEnded",
  "workspace.memberRemoved",
  "workspace.memberAssigned",
  "workspace.organizationMemberRemoved",
  "workspace.ownershipTransferred",
  "workspace.personArchived",
  "workspace.personPurged",
  "workspace.personRestored",
  "workspace.retentionChanged",
  "workspace.invited",
  "workspace.invitationRevoked",
  "workspace.invitationAccepted",
  "profile.updated",
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
  "marketplace",
  "memory",
  "artifact",
  "workspace",
  "user",
] as const;
export type AuditResource = (typeof AUDIT_RESOURCES)[number];

export const AUDIT_RESULTS = ["ok", "refused", "failed"] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

/**
 * Who did it: a person, a Job, or an agent's unattended work outside a Job (a trigger's firing,
 * a poll). `scheduler` is only on older rows that name no agent. A workflow step never writes a row.
 */
export type AuditActor = Exclude<EventActor, { type: "step" }> | { type: "agent"; agentId: string } | { type: "scheduler" };

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
  userId: id,
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
  /** A personal action's grant and the enrollment it spends (`runners/grants.ts`). */
  grantId: id,
  enrollmentId: id,
  /** A plugin's agent, tool or trigger a decision is about. */
  elementId: id,
  agentName: name,
  harnessName: name,
  runnerName: name,
  triggerName: name,
  toolName: name,
  tableName: name,
  /** The element's field a decision is about: its name, never its value. */
  field: name,
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
  /** A workspace role given: `manager` or `member`. */
  role: kind,
  elementKind: kind,
  /** A generated artifact's format (`html`, `svg`). */
  format: kind,
  item: n,
  items: n,
  jobs: n,
  fields: n,
  events: n,
  found: n,
  /** A size in bytes. */
  bytes: n,
  /** A platform tool's name. */
  tool: kind,
  /** A tool's action name. */
  action: name,
  /** Whom an escalation reached, and whom it left, by id (`engine/routing.ts`); its hop's number is `hop`, why it went there `reason`. */
  to: id,
  from: id,
  hop: n,
  /** How many people an escalation reached in all. */
  hops: n,
}).partial();
export type AuditDetails = z.infer<typeof AuditDetails>;
