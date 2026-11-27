import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { organizations, workspaces } from "../db/schema.ts";
import { rightsOf } from "../platform/rights.ts";
import { base, manager, member } from "../rpc/context.ts";
import { dailyAudit, DailyRange, daysIn } from "./daily.ts";
import { AuditCursorError, AuditFilter, listAudit } from "./list.ts";
import { message } from "../messages/index.ts";

const reader = base.use(member);
const writer = base.use(manager);

/**
 * The workspace's Audit rows, newest first, a page at a time (`listAudit`), narrowed by any filter.
 * Called by a Job (`audit_list`, `configure`): only rows naming no table or a table of the Job's.
 */
const list = writer.input(AuditFilter.extend({ cursor: z.string().max(1000).optional() })).handler(async ({ input, context }) => {
  const { cursor, ...filter } = input;
  const tables = context.job ? ((await rightsOf(context.db, context.job))?.tables ?? []) : "all";
  try {
    return await listAudit(context.db, context.actorId, context.access.workspaceId, filter, cursor, tables);
  } catch (err) {
    if (err instanceof AuditCursorError) throw new ORPCError("BAD_REQUEST", message("audit.badCursor"));
    throw err;
  }
});

/**
 * The workspace's Audit rows counted per day of a range (`dailyAudit`): the rows `list` reads, so
 * a Job sees the same as there, and counts only. A range is at most the organization's retention.
 */
const daily = writer.input(DailyRange).handler(async ({ input, context }) => {
  const workspaceId = context.access.workspaceId;
  const [org] = await context.db
    .select({ days: organizations.auditRetentionDays })
    .from(workspaces)
    .innerJoin(organizations, eq(organizations.id, workspaces.organizationId))
    .where(eq(workspaces.id, workspaceId));
  const days = daysIn(input);
  if (!org || days < 1 || days > org.days) throw new ORPCError("BAD_REQUEST", message("audit.dailyRange", { days: org?.days ?? 0 }));
  const tables = context.job ? ((await rightsOf(context.db, context.job))?.tables ?? []) : "all";
  try {
    return { timeZone: input.timeZone, days: await dailyAudit(context.db, workspaceId, input, tables) };
  } catch (err) {
    // The database doesn't know the zone (22023: not recognized).
    const e = err as { code?: unknown; cause?: { code?: unknown } };
    if (e.code === "22023" || e.cause?.code === "22023") throw new ORPCError("BAD_REQUEST", message("workflows.schedule.unknownTimezone"));
    throw err;
  }
});

/** Where a trace is opened (`DISPAND_TRACE_URL`, with `{traceId}`), for the Audit page's links; null when it isn't set. */
const traceUrl = reader.handler(({ context }) => ({ traceUrl: context.traceUrl ?? null }));

export const audit = { list, daily, traceUrl };
