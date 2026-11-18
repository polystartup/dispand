import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { agents, runs } from "../db/schema.ts";
import { jobMemoryPrompt } from "../memory/read.ts";
import { jobScope, startable } from "../questions/inbox-scope.ts";
import { stored } from "../messages/index.ts";
import { pollProblem } from "../tools/pollable.ts";
import { INTERACTION, JOB } from "../triggers/model.ts";
import { type Harness, isCloud, type StartParams } from "./harness.ts";
import { timezonePrompt } from "./job-def.ts";
import type { StepRow } from "./views.ts";

// What a Job reads with its rights as they are now, each time it needs them.

/**
 * A start as it is sent: a Job's gets its memory as it is now, after its agent's instructions
 * (and on a runner as files too), read with the Job's rights at this moment, and the owner's
 * time zone when they started it from their browser. The stored start never holds the memory,
 * so a start sent again (a reconcile, a slot handed over, a resume) reads it again.
 */
export async function withMemory(db: Db, harness: Harness, step: StepRow, start: StartParams): Promise<StartParams> {
  const [run] = await db.select().from(runs).where(eq(runs.id, step.runId));
  if (run?.source !== "agent" || !run.snapshot) return start;
  // A limited Job (a Stem Job) reads no memory: it holds no `configure` to filter what others
  // wrote by, and its one tool changes agents. Its instructions are the snapshot's alone.
  if (run.snapshot.only) return { ...start, systemPrompt: run.snapshot.systemPrompt };
  // Built from the snapshot's instructions, whatever the stored start holds. On a runner, the
  // same reading also goes as files (`CliHarnessAdapter.start`).
  const onRunner = !isCloud(harness);
  const { prompt, memory } = await jobMemoryPrompt(db, run, onRunner);
  const timezone = run.trigger.type === "manual" && run.trigger.timezone ? timezonePrompt(run.trigger.timezone) : "";
  return { ...start, systemPrompt: [run.snapshot.systemPrompt, timezone, prompt].filter(Boolean).join("\n\n"), ...(onRunner ? { jobMemory: memory } : {}) };
}

/** Why the run, a Job fired by a row's change, a Question or a poll's item, may no longer be told of it; null when it may (always, for another Job's event). */
export async function lostScope(db: Db, runId: string): Promise<string | null> {
  const [row] = await db
    .select({ ownerId: runs.ownerId, agentId: runs.agentId, trigger: runs.trigger, bundles: agents.bundles, dataTables: agents.dataTables })
    .from(runs)
    .leftJoin(agents, eq(agents.id, runs.agentId))
    .where(eq(runs.id, runId));
  if (row?.trigger.type === "poll") {
    const { toolId, action } = row.trigger;
    return row.agentId && !(await pollProblem(db, row.ownerId, row.agentId, toolId, action)) ? null : stored("engine.fail.scope.poll");
  }
  if (row?.trigger.type !== "event") return null;
  const tableId = row.trigger.outputs.table_id ?? "";
  // Another Job's ids and status: any agent may be told of them, so nothing is lost.
  if (tableId === JOB) return null;
  // A Question or an Approval: still one its Job may read, with the Job's rights as they are now (and, once asked, still open).
  if (tableId === INTERACTION) {
    const scope = row.agentId ? await jobScope(db, { runId, ownerId: row.ownerId, agentId: row.agentId }) : null;
    return scope && (await startable(db, scope, row.trigger.outputs.row_id ?? "", row.trigger.outputs.operation ?? "")) ? null : stored("engine.fail.scope.question");
  }
  return !row.bundles?.includes("data") || (row.dataTables !== "all" && !row.dataTables?.includes(tableId)) ? stored("engine.fail.scope.table") : null;
}
