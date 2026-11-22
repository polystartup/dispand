import { and, eq, exists, isNull } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { agents, harnesses, runners, runs, stepRuns } from "../db/schema.ts";
import type { CloudKind } from "../harnesses/cloud.ts";
import type { WorkflowNode } from "../workflows/model.ts";
import { CLOUD_SOURCE, type CliHarness, type Harness } from "./harness.ts";
import { stored } from "../messages/index.ts";
import { RUNNER_REVOKED } from "./errors.ts";
import { cliProblem } from "./problems.ts";
import type { RunRow, StepRow } from "./views.ts";

/** Whether the run being read belongs to this runner. Cloud sessions use the internal source. */
export function runnerForRun(db: Db | Tx, runnerId: string | typeof stepRuns.runnerId) {
  return exists(db.select({ id: runners.id }).from(runners).where(and(
    eq(runners.id, runnerId), eq(runners.workspaceId, runs.workspaceId), eq(runners.ownerId, runs.ownerId), isNull(runners.revokedAt),
  )));
}

/** The persisted session and its job must both belong to the source of a runner event. */
export function sessionSource(db: Db | Tx, runnerId: string) {
  return and(eq(stepRuns.runnerId, runnerId), runnerId === CLOUD_SOURCE ? undefined :
    exists(db.select({ id: runs.id }).from(runs).where(and(eq(runs.id, stepRuns.runId), runnerForRun(db, runnerId)))));
}

type HarnessRow = typeof harnesses.$inferSelect;
type RunnerRow = typeof runners.$inferSelect;

/**
 * What a step's session runs on: its agent's instructions, its harness's row and the harness as
 * the session gets it (with its runner's row, on a runner); or why it can't run, which fails it.
 */
export async function sessionHarness(
  db: Db,
  run: RunRow,
  node: WorkflowNode,
  step: StepRow,
): Promise<{ systemPrompt: string; h: HarnessRow; harness: Harness; runnerRow?: RunnerRow } | { problem: string }> {
  // A Job runs the agent as it was when the Job was created; a workflow run, as it is now.
  const [current] = run.snapshot
    ? []
    : await db
        .select({ systemPrompt: agents.systemPrompt, model: agents.model, harnessId: agents.harnessId })
        .from(agents)
        .where(and(eq(agents.id, node.agentId ?? ""), eq(agents.ownerId, run.ownerId), eq(agents.workspaceId, run.workspaceId)));
  // A Job of a deleted agent never runs again: its step fails as one whose agent is gone.
  const agent = run.source === "agent" && !run.agentId ? undefined : run.snapshot ? { ...run.snapshot, model: run.snapshot.model ?? null } : current;
  // The agent's harness as read here takes the slot and runs the session; a step handed a slot
  // keeps the harness it queued on, wherever its agent went since.
  const harnessId = step.working && step.harnessId ? step.harnessId : agent?.harnessId;
  const [h] = harnessId
    ? await db
        .select()
        .from(harnesses)
        .where(and(eq(harnesses.id, harnessId), eq(harnesses.ownerId, run.ownerId)))
    : [];
  if (!agent || !h) return { problem: stored("engine.fail.agentGone") };
  if (h.type === "cloud") {
    // The harness's settings and key are read at each model call: only the agent's model is kept.
    return { systemPrompt: agent.systemPrompt, h, harness: { id: h.id, type: "cloud", kind: h.kind as CloudKind, ...(agent.model ? { model: agent.model } : {}) } };
  }
  // A revoked runner never comes back: the step would wait forever.
  const [runner] = h.runnerId ? await db.select().from(runners).where(and(eq(runners.id, h.runnerId), eq(runners.workspaceId, run.workspaceId), eq(runners.ownerId, run.ownerId))) : [];
  const problem = !runner || runner.revokedAt || !h.permissionMode ? RUNNER_REVOKED : cliProblem(h.kind, runner);
  if (problem) return { problem };
  const model = agent.model ?? h.model;
  const harness = { id: h.id, runnerId: h.runnerId!, kind: h.kind, permissionMode: h.permissionMode, ...(model ? { model } : {}) } as CliHarness;
  return { systemPrompt: agent.systemPrompt, h, harness, runnerRow: runner };
}
