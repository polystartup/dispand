import { and, asc, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { platformSkillOf, syncPlatformSkill } from "../assistant/skill.ts";
import { agents, agentSkills, triggers } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { errorKind, logError } from "../log.ts";
import type { Bundle, TableScope } from "../platform/bundles.ts";
import { emitLog, inSpan, tracer } from "../telemetry/index.ts";
import type { TriggerConfig } from "../triggers/model.ts";
import { DEFAULT_TIMEZONE } from "../workflows/schedule.ts";

// The workspace's Assistant: an agent like the others, marked `builtIn: "assistant"`, one per
// owner. Its name, harness, model and instructions are the owner's to change; what makes it the
// Assistant (its bundles over every table, its platform skill, its chat) is not, and `assistantGuard` is the one
// place that says so, for the owner's procedures and for proposals alike.

const traces = tracer("assistant");

/** What the Assistant's Jobs may always do, on every table. */
export const ASSISTANT_BUNDLES: Bundle[] = ["data", "configure"];

/** What may be about to change on an agent, its triggers included. */
export type AgentChange =
  | { kind: "delete" }
  /** An update: only what it gives changes (`agents.update` leaves the rest as it is). */
  | { kind: "update"; bundles?: Bundle[]; dataTables?: TableScope; skillPackageIds?: string[] }
  | { kind: "trigger"; triggerId: string; delete?: boolean; enabled?: boolean; config?: TriggerConfig };

/**
 * The Assistant's review of the workspace: a schedule, Mondays at 09:00, made off. Turning it on is
 * the owner's (the switch on the Assistant's page sets their time zone then). One at a time: a
 * review waiting on the owner's answers isn't doubled by the next Monday's.
 */
export const REVIEW = {
  name: "Review the workspace",
  instructions:
    "Review the workspace, as your platform skill's review section says: call workspace_review, then make one proposal for each signal it gives, and ask for each with request_approval. Apply what is approved with proposal_apply. Change nothing else.",
  config: { kind: "schedule", cron: "0 9 * * 1", timezone: DEFAULT_TIMEZONE } satisfies TriggerConfig,
};

const isChat = (config: TriggerConfig) => config.kind === "manual" && config.placement === "chat";

/** The Assistant's chat: its oldest chat trigger, which the guard keeps. */
async function chatTriggerOf(db: Db | Tx, agentId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: triggers.id })
    .from(triggers)
    .where(and(eq(triggers.agentId, agentId), eq(triggers.kind, "manual"), sql`${triggers.config}->>'placement' = 'chat'`))
    .orderBy(asc(triggers.createdAt), asc(triggers.id))
    .limit(1);
  return row?.id ?? null;
}

/** The Assistant's review trigger (`REVIEW`), whatever the owner renamed it. */
async function reviewTriggerOf(db: Db | Tx, agentId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: triggers.id })
    .from(triggers)
    .where(and(eq(triggers.agentId, agentId), eq(triggers.builtIn, "review")));
  return row?.id ?? null;
}

/**
 * Why this change can't be made, or null when it can: the agent isn't the Assistant, or the change
 * keeps what makes it one. The Assistant can't be deleted, lose `data` or `configure`, be limited
 * to some tables, lose its platform skill, or lose its chat (deleted, turned off or made a button).
 */
export async function assistantGuard(db: Db | Tx, ownerId: string, agentId: string, change: AgentChange): Promise<string | null> {
  const [agent] = await db
    .select({ builtIn: agents.builtIn })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, ownerId)));
  if (agent?.builtIn !== "assistant") return null;
  if (change.kind === "delete") return "The Assistant can't be deleted";
  if (change.kind === "update") {
    if (change.bundles && !ASSISTANT_BUNDLES.every((b) => change.bundles!.includes(b))) return "The Assistant keeps working on data and changing tables";
    if (change.dataTables !== undefined && change.dataTables !== "all") return "The Assistant keeps working on all tables";
    if (change.skillPackageIds) {
      const platform = await platformSkillOf(db, ownerId);
      if (platform && !change.skillPackageIds.includes(platform)) return "The Assistant keeps its platform skill";
    }
    return null;
  }
  if (change.delete && (await reviewTriggerOf(db, agentId)) === change.triggerId) return "The Assistant's review can't be deleted: turn it off instead";
  if (change.triggerId !== (await chatTriggerOf(db, agentId))) return null;
  if (change.delete) return "The Assistant's chat can't be deleted";
  if (change.enabled === false) return "The Assistant's chat can't be turned off";
  if (change.config && !isChat(change.config)) return "The Assistant's chat stays a chat";
  return null;
}

/** The owner's Assistant and its chat, or null when there is none yet. */
export async function findAssistant(db: Db | Tx, ownerId: string): Promise<{ agentId: string; triggerId: string; reviewTriggerId: string | null } | null> {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.builtIn, "assistant")));
  if (!agent) return null;
  const triggerId = await chatTriggerOf(db, agent.id);
  return triggerId ? { agentId: agent.id, triggerId, reviewTriggerId: await reviewTriggerOf(db, agent.id) } : null;
}

/**
 * Makes the owner's Assistant, on `harnessId`, unless there is one: then it is left on its own
 * harness, and only what it lacks (its platform skill, its chat, its review) is added. The platform skill is
 * written from the build's files first (`syncPlatformSkill`). One row per owner whatever runs it at
 * once (the partial unique index). `harnessId` must be the owner's: the caller checks it.
 */
export async function ensureAssistant(db: Db, ownerId: string, harnessId: string): Promise<{ agentId: string; triggerId: string; reviewTriggerId: string | null }> {
  return inSpan(traces, "assistant.ensure", {}, errorKind, (span) =>
    db.transaction(async (tx) => {
      const own = and(eq(agents.ownerId, ownerId), eq(agents.builtIn, "assistant"));
      const [made] = await tx
        .insert(agents)
        .values({ id: newId("agent"), ownerId, name: "Assistant", harnessId, systemPrompt: "", bundles: ASSISTANT_BUNDLES, dataTables: "all", builtIn: "assistant" })
        .onConflictDoNothing()
        .returning({ id: agents.id });
      const [agent] = made ? [made] : await tx.select({ id: agents.id }).from(agents).where(own);
      span.setAttributes({ "dispand.agent.id": agent!.id, "dispand.result": made ? "created" : "existing" });
      if (made) emitLog("assistant", "info", "assistant.created", { "dispand.agent.id": made.id });
      const packageId = await syncPlatformSkill(tx, ownerId);
      await tx.insert(agentSkills).values({ agentId: agent!.id, packageId }).onConflictDoNothing();
      // Off, so no time to fire: turning it on computes its next Monday (`scheduleColumns`).
      await tx
        .insert(triggers)
        .values({ id: newId("trigger"), ownerId, agentId: agent!.id, kind: "schedule", name: REVIEW.name, instructions: REVIEW.instructions, config: REVIEW.config, enabled: false, concurrency: "one-at-a-time", builtIn: "review" })
        .onConflictDoNothing();
      const reviewTriggerId = await reviewTriggerOf(tx, agent!.id);
      const found = await chatTriggerOf(tx, agent!.id);
      if (found) return { agentId: agent!.id, triggerId: found, reviewTriggerId };
      const triggerId = newId("trigger");
      await tx.insert(triggers).values({ id: triggerId, ownerId, agentId: agent!.id, kind: "manual", name: "Chat", instructions: "", config: { kind: "manual", placement: "chat" } });
      return { agentId: agent!.id, triggerId, reviewTriggerId };
    }),
  );
}

/**
 * At server start: every owner's Assistant gets what it lacks, so what a new version adds to it
 * reaches installs that already have one. A failure is logged and doesn't stop the server.
 */
export async function ensureAssistants(db: Db): Promise<void> {
  const rows = await db.select({ ownerId: agents.ownerId, harnessId: agents.harnessId }).from(agents).where(eq(agents.builtIn, "assistant"));
  for (const row of rows) {
    await ensureAssistant(db, row.ownerId, row.harnessId).catch((err: unknown) => logError("assistant.ensure failed", err));
  }
}
