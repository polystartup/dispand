import { z } from "zod";
import { MEMORY_TARGETS } from "../memory/model.ts";
import { BUNDLES, type TableScope } from "../platform/bundles.ts";

// JSONB columns the engine acts on: one schema each gives the column's type (`schema.ts`) and the
// check where the engine acts on a stored value, so a writer and a reader can't drift.

/** Why an action can't spend its subscription now (`runners/grants.ts`). */
export const Paused = z.enum(["off", "actor", "enrollment", "access", "ended", "approver", "worker"]);
export type Paused = z.infer<typeof Paused>;

/**
 * What a step does once it holds a slot: its session's start, the answers and chat messages that
 * wait for it (`deliver`), or its lost session's resume, which carries those too.
 */
export const PendingAction = z.object({ kind: z.enum(["start", "deliver", "resume"]), paused: Paused.optional() });
export type PendingAction = z.infer<typeof PendingAction>;

/** The agent as it was when its Job was created: the Job's sessions read it, not the `agents` row. */
export const AgentSnapshot = z.object({
  /** Packages explicitly invoked by the person in this Assistant conversation. */
  invokedSkills: z.array(z.string()).optional(),
  id: z.string(),
  name: z.string(),
  harnessId: z.string(),
  systemPrompt: z.string(),
  model: z.string().optional(),
  skills: z.array(z.object({ packageId: z.string(), name: z.string() })),
  tools: z.array(z.object({ toolId: z.string(), name: z.string() })),
  /**
   * Absent in Jobs created before bundles existed: none, on all tables. Jobs created before
   * migration 0099 may still hold the `inbox` bundle it removed, which gives nothing.
   */
  bundles: z.preprocess((v) => (Array.isArray(v) ? v.filter((b) => b !== "inbox") : v), z.array(z.enum(BUNDLES))).optional(),
  tables: z.union([z.literal("all"), z.array(z.string())]).optional() satisfies z.ZodType<TableScope | undefined>,
  /** Where its Jobs may write memory; absent in Jobs created before self-learning existed: nowhere. */
  selfLearning: z.array(z.enum(MEMORY_TARGETS)).optional(),
  /** The agents it could consult at its start (`consultRights`); absent in Jobs created before consults existed: none. */
  consults: z.array(z.object({ agentId: z.string() })).optional(),
  /** The people it could ask at its start (`escalationRights`); absent in Jobs created before escalations existed: none. */
  escalations: z.array(z.object({ userId: z.string() })).optional(),
  /** The only tools of Dispand's the Job may call, whatever its bundles: a Stem Job's `plugin_decide`. */
  only: z.array(z.string()).optional(),
  /** The agent's `revision` it was made from: strict permissions hold only for it. Absent in Jobs made before: the agent's current one. */
  revision: z.number().int().optional(),
});
export type AgentSnapshot = z.infer<typeof AgentSnapshot>;
