import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { rightsOf } from "../platform/rights.ts";
import { authed, base } from "../rpc/context.ts";
import { AuditCursorError, AuditFilter, listAudit } from "./list.ts";

const owner = base.use(authed);

/**
 * The owner's Audit rows, newest first, a page at a time (`listAudit`), narrowed by any filter.
 * Called by a Job (`audit_list`, `configure`): only rows naming no table or a table of the Job's.
 */
const list = owner.input(AuditFilter.extend({ cursor: z.string().max(1000).optional() })).handler(async ({ input, context }) => {
  const { cursor, ...filter } = input;
  const tables = context.job ? ((await rightsOf(context.db, context.job))?.tables ?? []) : "all";
  try {
    return await listAudit(context.db, context.ownerId, filter, cursor, tables);
  } catch (err) {
    if (err instanceof AuditCursorError) throw new ORPCError("BAD_REQUEST", { message: "Invalid cursor" });
    throw err;
  }
});

/** Where a trace is opened (`DISPAND_TRACE_URL`, with `{traceId}`), for the Audit page's links; null when it isn't set. */
const traceUrl = owner.handler(({ context }) => ({ traceUrl: context.traceUrl ?? null }));

export const audit = { list, traceUrl };
