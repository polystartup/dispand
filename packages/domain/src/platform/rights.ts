import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { agents, runs } from "../db/schema.ts";
import type { MemoryTarget } from "../memory/model.ts";
import type { TableScope } from "./bundles.ts";

// What a Job, or an agent, may use now: the one place the platform's authorization reads it.

/** The Job a call is made for. */
export type JobIdentity = { runId: string; ownerId: string; agentId: string };

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
 * Job is over (or when the identity names no Job of that owner and agent).
 */
export async function rightsOf(db: Db | Tx, job: JobIdentity): Promise<Rights | null> {
  const [row] = await db
    .select({ status: runs.status, snapshot: runs.snapshot, bundles: agents.bundles, dataTables: agents.dataTables, selfLearning: agents.selfLearning })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .where(and(eq(runs.id, job.runId), eq(runs.ownerId, job.ownerId), eq(runs.agentId, job.agentId), eq(runs.source, "agent")));
  if (!row || (row.status !== "running" && row.status !== "waiting")) return null;
  const snapshot = row.snapshot;
  return {
    bundles: (snapshot?.bundles ?? []).filter((b) => row.bundles.includes(b)),
    tables: narrow(snapshot?.tables ?? "all", row.dataTables),
    selfLearning: (snapshot?.selfLearning ?? []).filter((t) => row.selfLearning.includes(t)),
    ...(snapshot?.only ? { only: snapshot.only } : {}),
  };
}
