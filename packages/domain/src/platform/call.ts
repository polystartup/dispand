import { call, ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { agents, runs } from "../db/schema.ts";
import { logError } from "../log.ts";
import type { InitialContext } from "../rpc/context.ts";
import { router } from "../rpc/router.ts";
import type { TableScope } from "./bundles.ts";
import { createProposal, takeItem } from "./proposals.ts";
import { PLATFORM_TOOLS, procedureOf, PROPOSE, type PlatformTool } from "./tools.ts";

// The one way a Job's session calls Dispand's own procedures, for a cloud session (in process)
// and for the Job endpoint alike: every call is authorized here, against the Job and against
// its agent as it is now.

/** The Job a call is made for. */
export type JobIdentity = { runId: string; ownerId: string; agentId: string };

/** What a call needs of the app: the procedures' context, without a request. */
export type PlatformApp = Omit<InitialContext, "headers" | "resHeaders" | "job">;

export type ToolResult = { ok: true; output: unknown } | { ok: false; error: string };

const ALL = [...PLATFORM_TOOLS, PROPOSE];
const NEEDS_PROPOSAL =
  "This change needs the owner's approval: list it in a proposal (propose), ask for it (request_approval with the proposal's id), then make the call exactly as listed, once.";
const OVER = "This Job is over";
const NOT_FOUND = "Not found";

/** Both lists narrowed to what is in each: "all" only when both are. */
function narrow(a: TableScope, b: TableScope): TableScope {
  if (a === "all") return b;
  if (b === "all") return a;
  return a.filter((id) => b.includes(id));
}

/**
 * What the Job may use now: the bundles and tables of its snapshot that its agent still has.
 * Rights shrink with the agent at once and never grow after the Job was created. Null once the
 * Job is over (or when the identity names no Job of that owner and agent).
 */
async function rightsOf(db: Db, job: JobIdentity): Promise<{ bundles: string[]; tables: TableScope } | null> {
  const [row] = await db
    .select({ status: runs.status, snapshot: runs.snapshot, bundles: agents.bundles, dataTables: agents.dataTables })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .where(and(eq(runs.id, job.runId), eq(runs.ownerId, job.ownerId), eq(runs.agentId, job.agentId), eq(runs.source, "agent")));
  if (!row || (row.status !== "running" && row.status !== "waiting")) return null;
  const snapshot = row.snapshot;
  return {
    bundles: (snapshot?.bundles ?? []).filter((b) => row.bundles.includes(b)),
    tables: narrow(snapshot?.tables ?? "all", row.dataTables),
  };
}

/** The tools the Job may use now; none once it is over. */
export async function toolsOf(db: Db, job: JobIdentity): Promise<PlatformTool[]> {
  const rights = await rightsOf(db, job);
  return rights ? ALL.filter((t) => rights.bundles.includes(t.bundle)) : [];
}

/**
 * Calls one of Dispand's tools for a Job: the tool must be declared, the Job still going, the
 * tool's bundle and every table the call touches within the Job's rights. The procedure then
 * runs in process as the Job's owner. A refusal or a failure comes back as words for the agent,
 * never as internals.
 */
export async function callPlatformTool(app: PlatformApp, job: JobIdentity, name: string, input: unknown): Promise<ToolResult> {
  const tool = ALL.find((t) => t.name === name);
  if (!tool) return { ok: false, error: "Unknown tool" };
  try {
    const rights = await rightsOf(app.db, job);
    if (!rights) return { ok: false, error: OVER };
    if (!rights.bundles.includes(tool.bundle)) return { ok: false, error: `This agent may not use ${tool.name}` };
    const parsed = tool.input.safeParse(input ?? {});
    if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") };
    const scope = rights.tables;
    const touched = await tool.tables(app.db, job.ownerId, parsed.data);
    // Outside the Job's tables, or naming nothing: the same answer, so a Job learns nothing about what it can't reach.
    if (touched.some((id) => id === null || (scope !== "all" && !scope.includes(id)))) return { ok: false, error: NOT_FOUND };
    if (tool === PROPOSE) {
      const made = await createProposal(app.db, job, ALL.filter((t) => rights.bundles.includes(t.bundle)), scope, parsed.data);
      if ("error" in made) return { ok: false, error: made.error };
      return {
        ok: true,
        output: { ...made, next: `Now call request_approval with a message saying what you propose and why, and proposal: "${made.proposalId}". Once approved, make each call exactly as listed.` },
      };
    }
    // What changes what agents may do: only as a person approved it for this Job, and once.
    if (tool.grant && !(await takeItem(app.db, job, tool.name, parsed.data))) return { ok: false, error: NEEDS_PROPOSAL };
    const output = await call(procedureOf(router, tool.path) as never, parsed.data as never, {
      context: { ...app, job, headers: new Headers(), resHeaders: new Headers() } as never,
      // The procedure's name, for its span: a call in process has none of its own.
      path: tool.path.split("."),
    });
    return { ok: true, output: tool.filter ? tool.filter(output, scope) : output };
  } catch (err) {
    if (err instanceof ORPCError) return { ok: false, error: err.code === "NOT_FOUND" ? NOT_FOUND : err.message };
    logError("platform tool failed", err, { ref: `${job.runId}:${tool.name}` });
    return { ok: false, error: "The tool failed" };
  }
}
