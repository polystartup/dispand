import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { agents, runs } from "../db/schema.ts";
import type { MemoryTarget } from "../memory/model.ts";
import { message } from "../messages/index.ts";
import { overriddenAfter } from "../plugins/overrides.ts";
import { emitLog } from "../telemetry/index.ts";
import { MAX_AGENT_TABLES, type TableScope } from "./bundles.ts";

// What a Job, or an agent, may use now: the one place the platform's authorization reads it.

/** The Job a call is made for. */
/** `traceId` and `spanId`: the Job's stored span, when the identity was read from its run (`jobOfToken`). */
export type JobIdentity = { runId: string; ownerId: string; workspaceId: string; agentId: string; traceId?: string | null; spanId?: string | null };

/** Bundles, the tables they apply to, and where the Job may write memory. */
/** `only`: the only tools of Dispand's the Job may call, whatever its bundles (a Stem Job). */
export type Rights = { bundles: string[]; tables: TableScope; selfLearning: MemoryTarget[]; only?: string[] };

/** Both lists narrowed to what is in each: "all" only when both are. */
export function narrow(a: TableScope, b: TableScope): TableScope {
  if (a === "all") return b;
  if (b === "all") return a;
  return a.filter((id) => b.includes(id));
}

/** Whether every table of `inner` is one of `outer`'s. */
export function within(inner: TableScope, outer: TableScope): boolean {
  if (outer === "all") return true;
  return inner !== "all" && inner.every((id) => outer.includes(id));
}

/**
 * What the Job may use now: the bundles, tables and self-learning targets of its snapshot that its agent still has.
 * Rights shrink with the agent at once and never grow after the Job was created. Null once the
 * Job is over (or when the identity names no Job of that workspace and agent).
 */
export async function rightsOf(db: Db | Tx, job: JobIdentity): Promise<(Rights & { workspaceId: string }) | null> {
  const [row] = await db
    .select({ workspaceId: runs.workspaceId, status: runs.status, snapshot: runs.snapshot, bundles: agents.bundles, dataTables: agents.dataTables, selfLearning: agents.selfLearning })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .where(and(eq(runs.id, job.runId), eq(runs.workspaceId, job.workspaceId), eq(runs.agentId, job.agentId), eq(runs.source, "agent")));
  if (!row || (row.status !== "running" && row.status !== "waiting")) return null;
  const snapshot = row.snapshot;
  return {
    workspaceId: row.workspaceId,
    bundles: (snapshot?.bundles ?? []).filter((b) => row.bundles.includes(b)),
    tables: narrow(snapshot?.tables ?? "all", row.dataTables),
    selfLearning: (snapshot?.selfLearning ?? []).filter((t) => row.selfLearning.includes(t)),
    ...(snapshot?.only ? { only: snapshot.only } : {}),
  };
}

/**
 * A table the Job just created, in `tx`, joins its agent's tables and the Job's own, where each is
 * a list ("all" has it already): we decided a limited agent keeps what it makes. Only this table,
 * nothing else. Both rows are locked first (the agent, then the run: the order an agent's
 * delete takes them in, `deleteAgents`), so two Jobs creating tables at once each add theirs.
 * On a plugin's agent, the tables become the owner's override.
 */
export async function joinCreatedTable(tx: Tx, job: JobIdentity, tableId: string): Promise<void> {
  const [agent] = await tx.select().from(agents).where(and(eq(agents.id, job.agentId), eq(agents.workspaceId, job.workspaceId))).for("update");
  const [run] = await tx.select({ snapshot: runs.snapshot }).from(runs).where(and(eq(runs.id, job.runId), eq(runs.workspaceId, job.workspaceId))).for("update");
  let joined = false;
  if (agent && agent.dataTables !== "all") {
    // Past the most an agent's form takes, the owner could no longer save the agent.
    if (agent.dataTables.length >= MAX_AGENT_TABLES) throw new ORPCError("BAD_REQUEST", message("agent.tablesFull", { max: MAX_AGENT_TABLES }));
    const dataTables = [...agent.dataTables, tableId];
    await tx.update(agents).set({ dataTables, overridden: overriddenAfter("agent", agent, { dataTables }) }).where(eq(agents.id, agent.id));
    joined = true;
  }
  const tables = run?.snapshot?.tables;
  if (Array.isArray(tables)) {
    await tx.update(runs).set({ snapshot: { ...run!.snapshot!, tables: [...tables, tableId] } }).where(eq(runs.id, job.runId));
    joined = true;
  }
  if (joined) emitLog("platform", "info", "table joined the job's tables", { "dispand.job.id": job.runId, "dispand.agent.id": job.agentId, "dispand.table.id": tableId });
}
