import { call, ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { AuditId } from "../audit/model.ts";
import { recordAuditAfter, type AuditEntry } from "../audit/record.ts";
import { auditResource } from "../audit/resource.ts";
import type { Db } from "../db/client.ts";
import { tables } from "../db/schema.ts";
import { logError } from "../log.ts";
import type { InitialContext } from "../rpc/context.ts";
import { router } from "../rpc/router.ts";
import { emitLog, meter, recordError, tracer } from "../telemetry/index.ts";
import { approvedItems, createProposal, issues, recordInPlugin, recordOutcome, resolveRefs, takeItem, type ItemAt } from "./proposals.ts";
import type { TableScope } from "./bundles.ts";
import { rightsOf, type JobIdentity } from "./rights.ts";
import { allowed, APPLY, INBOX_TOOLS, MEMORY_TOOLS, PLATFORM_TOOLS, procedureOf, PROPOSE, WHOLE_WORKSPACE, type PlatformTool } from "./tools.ts";

// The one way a Job's session calls Dispand's own procedures, for a cloud session (in process)
// and for the Job endpoint alike: every call is authorized here, against the Job and against
// its agent as it is now.

/** What a call needs of the app: the procedures' context, without a request. */
export type PlatformApp = Omit<InitialContext, "headers" | "resHeaders" | "job">;

export type ToolResult = { ok: true; output: unknown } | { ok: false; error: string };

/** Every tool a Job may be given. */
export const ALL_TOOLS = [...PLATFORM_TOOLS, PROPOSE, APPLY, ...INBOX_TOOLS, ...MEMORY_TOOLS];
const NEEDS_PROPOSAL =
  "This change needs the owner's approval: list it in a proposal (propose), ask for it (request_approval with the proposal's id), then have proposal_apply make it, or make the call exactly as listed, once.";
const OVER = "This Job is over";
const ITEM_USED = "This item was made already";
const NOT_FOUND = "Not found";

const traces = tracer("platform");
const counts = meter("platform");

export type { JobIdentity };

/** The tools the Job may use now; none once it is over. */
export async function toolsOf(db: Db, job: JobIdentity): Promise<PlatformTool[]> {
  const rights = await rightsOf(db, job);
  return rights ? ALL_TOOLS.filter((t) => allowed(t, rights)) : [];
}

/** What a call came to, for its Audit row: never its input or its output's content. */
type Seen = { reason?: string; failed?: true; tableId?: string; taken?: ItemAt | null; output?: unknown };

/**
 * Calls one of Dispand's tools for a Job: the tool must be declared, the Job still going, the
 * tool (its bundle, or its own rule) and every table the call touches within the Job's rights. The procedure then
 * runs in process as the Job's owner. `at`: the item of an approved proposal this call makes
 * (`proposal_apply`), and no other. A refusal or a failure comes back as words for the agent,
 * never as internals. Every call, a read or a refused one included, leaves one `platform.call`
 * Audit row, written after it: a failure to write it never changes what the call returns.
 */
export async function callPlatformTool(app: PlatformApp, job: JobIdentity, name: string, input: unknown, at?: ItemAt): Promise<ToolResult> {
  const tool = ALL_TOOLS.find((t) => t.name === name);
  const seen: Seen = {};
  try {
    if (!tool) {
      seen.reason = "unknown-tool";
      return { ok: false, error: "Unknown tool" };
    }
    return await attempt(app, job, tool, input, at, seen);
  } finally {
    await recordAuditAfter(app.db, auditEntry(job, tool, input, seen));
  }
}

/** The call's Audit row: what the server resolved (the tool, its table, the proposal item it made), never the agent's words. */
function auditEntry(job: JobIdentity, tool: PlatformTool | undefined, input: unknown, seen: Seen): AuditEntry {
  const ok = seen.reason === undefined && !seen.failed;
  return {
    ownerId: job.ownerId,
    actor: { type: "job", runId: job.runId },
    agentId: job.agentId,
    jobId: job.runId,
    action: "platform.call",
    resource: tool ? auditResource(tool, input, ok ? seen.output : undefined) : { type: "workspace", id: null },
    result: ok ? "ok" : seen.failed ? "failed" : "refused",
    details: {
      ...(tool ? { tool: tool.name } : {}),
      ...(seen.tableId ? { tableId: seen.tableId } : {}),
      ...(seen.taken ? { proposalId: seen.taken.proposalId, item: seen.taken.index } : {}),
      ...(seen.reason ? { reason: seen.reason } : {}),
    },
  };
}

/**
 * The table a call's row names, resolved before the call (a table it deletes is still there):
 * the first it touches that is one of the owner's (an input may name anything) and within the
 * Job's, so `audit_list` hides no row of the Job's own refusals and a Job can't tell a table it
 * can't reach from an id that names nothing. Never throws: a lookup that fails names none.
 */
async function resolvedTable(db: Db, ownerId: string, touched: (string | null)[], scope: TableScope): Promise<string | undefined> {
  const candidate = touched.find((id): id is string => id !== null && id !== WHOLE_WORKSPACE && AuditId.safeParse(id).success);
  if (candidate === undefined || (scope !== "all" && !scope.includes(candidate))) return undefined;
  const found = await db
    .select({ id: tables.id })
    .from(tables)
    .where(and(eq(tables.id, candidate), eq(tables.ownerId, ownerId)))
    .catch(() => []);
  return found.length > 0 ? candidate : undefined;
}

async function attempt(app: PlatformApp, job: JobIdentity, tool: PlatformTool, input: unknown, at: ItemAt | undefined, seen: Seen): Promise<ToolResult> {
  const refuse = (reason: string, error: string): ToolResult => {
    seen.reason = reason;
    return { ok: false, error };
  };
  const done = (result: ToolResult): ToolResult => {
    if (result.ok) seen.output = result.output;
    else seen.reason ??= "refused";
    return result;
  };
  let taken: ItemAt | null = null;
  try {
    const rights = await rightsOf(app.db, job);
    if (!rights) return refuse("over", OVER);
    if (!allowed(tool, rights)) return refuse("bundle", `This agent may not use ${tool.name}`);
    const parsed = tool.input.safeParse(input ?? {});
    if (!parsed.success) return refuse("invalid", issues(parsed.error));
    const scope = rights.tables;
    const touched = await tool.tables(app.db, job.ownerId, parsed.data);
    seen.tableId = await resolvedTable(app.db, job.ownerId, touched, scope);
    // Outside the Job's tables, or naming nothing: the same answer, so a Job learns nothing about what it can't reach.
    if (touched.some((id) => id === null || (scope !== "all" && !scope.includes(id)))) return refuse("not-found", NOT_FOUND);
    if (tool === PROPOSE) {
      const made = await createProposal(app.db, job, ALL_TOOLS.filter((t) => allowed(t, rights)), scope, parsed.data);
      if ("error" in made) return refuse("invalid", made.error);
      return done({
        ok: true,
        output: { ...made, next: `Now call the tool request_approval (in Claude Code it is mcp__dispand__request_approval, not a tool of the job server) with a message saying what you propose and why, and proposal: "${made.proposalId}". Once approved, call proposal_apply with proposalId "${made.proposalId}": it makes every call as listed, in order.` },
      });
    }
    if (tool === APPLY) return done(await applyProposal(app, job, (parsed.data as { proposalId: string }).proposalId));
    if (tool.run) return done(await tool.run(app, job, parsed.data, rights));
    // What changes what agents may do: only as a person approved it for this Job, and once. Any
    // other write uses a matching item too, so what it creates is what later items name.
    taken = at || tool.grant || tool.write ? await takeItem(app.db, job, tool.name, parsed.data, at) : null;
    seen.taken = taken;
    if (!taken && at) return refuse("item-used", ITEM_USED);
    if (!taken && tool.grant) return refuse("needs-proposal", NEEDS_PROPOSAL);
    const approvedInput = taken?.toolPermissions ? { ...(parsed.data as object), toolPermissions: taken.toolPermissions } : parsed.data;
    const output = await call(procedureOf(router, tool.path) as never, approvedInput as never, {
      context: { ...app, job, approvedToolTargets: taken?.toolPermissions?.map((p) => ({ toolId: p.toolId, target: p.target })), headers: new Headers(), resHeaders: new Headers() } as never,
      // The procedure's name, for its span: a call in process has none of its own.
      path: tool.path.split("."),
    });
    // The item is made: what it created, for the items that name it.
    const created = taken && tool.creates?.id(output);
    if (taken) await recordOutcome(app.db, taken, created ? { createdId: created } : {});
    // Made by `proposal_apply` or by a direct call alike: listed in the generated plugin the proposal names.
    // Bookkeeping only: a failure here never turns the write that was made into a refusal.
    if (taken && created) await recordInPlugin(app.db, job.ownerId, taken.proposalId).catch((e: unknown) => logError("generated plugin not recorded", e, { ref: taken!.proposalId }));
    seen.output = output;
    return { ok: true, output: tool.filter ? tool.filter(output, scope) : output };
  } catch (err) {
    // A used item whose call failed: shown so, and the items naming it can't run.
    if (taken) await recordOutcome(app.db, taken, { failed: true }).catch((e: unknown) => logError("proposal item not recorded", e, { ref: taken!.proposalId }));
    if (err instanceof ORPCError) return refuse(err.code === "NOT_FOUND" ? "not-found" : err.code.toLowerCase(), err.code === "NOT_FOUND" ? NOT_FOUND : err.message);
    seen.failed = true;
    logError("platform tool failed", err, { ref: `${job.runId}:${tool.name}` });
    return { ok: false, error: "The tool failed" };
  }
}

type Outcome = { $item: number; tool: string; outcome: "made" | "made before" | "being made" | "refused" | "refused before" | "not made"; id?: string; error?: string };

/**
 * `proposal_apply`: the unused items of an approved proposal of the Job, in order, each through
 * `callPlatformTool` as that very item, references replaced by what their items created. Stops at
 * the first refusal; nothing is undone (some items reach the network), and a later call goes on
 * from the first item not made.
 */
function applyProposal(app: PlatformApp, job: JobIdentity, proposalId: string): Promise<ToolResult> {
  return traces.startActiveSpan("platform.proposal_apply", { attributes: { "dispand.job.id": job.runId } }, async (span): Promise<ToolResult> => {
    let result = "refused";
    try {
      const first = await approvedItems(app.db, job, proposalId);
      if (typeof first === "string") return { ok: false, error: first };
      // Only once it names a proposal of the Job's: never an id the agent made up.
      span.setAttribute("dispand.proposal.id", proposalId);
      const outcomes: Outcome[] = [];
      let stopped: string | null = null;
      for (let index = 0; index < first.length && stopped === null; index++) {
        // Read again for each item: an item made meanwhile, and what each made.
        const items = await approvedItems(app.db, job, proposalId);
        if (typeof items === "string") return { ok: false, error: items };
        const item = items[index]!;
        // Taken by a call still running (another apply, or a direct call): what comes after it waits for its outcome.
        if (item.pending) {
          outcomes.push({ $item: index, tool: item.tool, outcome: "being made" });
          stopped = `Item ${index + 1} (${item.tool}) is being made by another call`;
          continue;
        }
        if (item.usedAt !== undefined) {
          outcomes.push({ $item: index, tool: item.tool, outcome: item.failed ? "refused before" : "made before", ...(item.createdId ? { id: item.createdId } : {}) });
          continue;
        }
        const input = resolveRefs(items, item.input);
        const done = input === null ? { ok: false as const, error: "It names an item that created nothing, so it can't be made: propose it again with real ids" } : await callPlatformTool(app, job, item.tool, input, { proposalId, index });
        if (!done.ok) {
          outcomes.push({ $item: index, tool: item.tool, outcome: "refused", error: done.error });
          stopped = `Item ${index + 1} (${item.tool}) was refused: ${done.error}`;
          continue;
        }
        const id = ALL_TOOLS.find((t) => t.name === item.tool)?.creates?.id(done.output);
        outcomes.push({ $item: index, tool: item.tool, outcome: "made", ...(id ? { id } : {}) });
      }
      for (const [index, item] of first.entries()) if (index >= outcomes.length) outcomes.push({ $item: index, tool: item.tool, outcome: "not made" });
      const made = outcomes.filter((o) => o.outcome === "made" || o.outcome === "made before").length;
      const refusedBefore = outcomes.filter((o) => o.outcome === "refused before").map((o) => o.$item + 1);
      result = stopped ? "stopped" : refusedBefore.length ? "partial" : "done";
      span.setAttributes({ "dispand.proposal.items": first.length, "dispand.proposal.made": made });
      if (stopped) {
        recordError(span, "stopped");
        emitLog("platform", "info", "proposal apply stopped", { "dispand.proposal.id": proposalId, "dispand.proposal.items": first.length, "dispand.proposal.made": made });
      }
      return {
        ok: true,
        output: {
          items: outcomes,
          next: stopped
            ? `${stopped}. The items after it weren't made. Tell the owner which were made and why it stopped; once the cause is fixed, call proposal_apply again to go on from the first item not made, or propose again what is left.`
            : refusedBefore.length
              ? `Every other item is made, but item${refusedBefore.length > 1 ? "s" : ""} ${refusedBefore.join(", ")} ${refusedBefore.length > 1 ? "were" : "was"} refused before and can't be made again: tell the owner, and propose again what is left.`
              : "Every item is made.",
        },
      };
    } finally {
      span.setAttribute("dispand.result", result);
      counts.counter("dispand.proposals.applied").add(1, { "dispand.result": result });
      span.end();
    }
  });
}
