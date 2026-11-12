import { and, desc, eq, gte, inArray, isNull, like, lte, ne, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Tx } from "../db/client.ts";
import { agents, audit, runs } from "../db/schema.ts";
import { jobAgentNameSql } from "../jobs/agent-name.ts";
import type { TableScope } from "../platform/bundles.ts";
import { AUDIT_ACTIONS, AUDIT_FAMILIES, AUDIT_RESOURCES, AUDIT_RESULTS } from "./model.ts";

/** Rows per page of `listAudit`, newest first. */
export const AUDIT_PAGE = 50;

/** What a list is narrowed to: an action is one action or a family (`job`). */
export const AuditFilter = z.object({
  actorType: z.enum(["user", "job", "scheduler"]).optional(),
  agentId: z.string().max(200).optional(),
  jobId: z.string().max(200).optional(),
  action: z.union([z.enum(AUDIT_ACTIONS), z.enum(AUDIT_FAMILIES)]).optional(),
  resourceType: z.enum(AUDIT_RESOURCES).optional(),
  resourceId: z.string().max(200).optional(),
  result: z.enum(AUDIT_RESULTS).optional(),
  // ISO 8601 strings rather than dates: the filter is a tool's input too, given as JSON Schema.
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
export type AuditFilter = z.infer<typeof AuditFilter>;

/** Where the next page starts: the last row's time (to the microsecond, as stored) and id. */
const Cursor = z.object({ at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/), id: z.string().max(200) });

/** A row as listed: `at` to the microsecond, and its agent's name as the agent is now, or as its Job kept it once deleted. */
export type AuditRow = Omit<typeof audit.$inferSelect, "at"> & { at: string; agentName: string | null };

/** A cursor that isn't one of ours. */
export class AuditCursorError extends Error {}

function decode(cursor: string): z.infer<typeof Cursor> {
  try {
    return Cursor.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new AuditCursorError("Invalid cursor");
  }
}

/**
 * The owner's rows, newest first, `AUDIT_PAGE` at a time, as `filter` narrows them. Pages are
 * keyed on `(at, id)`: a row written meanwhile never shifts a page. The cursor carries `at` as
 * Postgres prints it, since a JavaScript date would lose its microseconds. `tables`: a Job's
 * tables; a row naming any other table (in `details.tableId`, or as a table resource) is left
 * out in the query, before the page's limit and its cursor. Rows naming no table stay.
 */
export async function listAudit(db: Db | Tx, ownerId: string, filter: AuditFilter, cursor?: string, tables: TableScope = "all"): Promise<{ rows: AuditRow[]; next: string | null }> {
  const where: (SQL | undefined)[] = [eq(audit.ownerId, ownerId)];
  if (tables !== "all") {
    const tableId = sql`${audit.details}->>'tableId'`;
    where.push(or(isNull(tableId), inArray(tableId, tables)), or(ne(audit.resourceType, "table"), isNull(audit.resourceId), inArray(audit.resourceId, tables)));
  }
  if (filter.actorType) where.push(sql`${audit.actor}->>'type' = ${filter.actorType}`);
  if (filter.agentId) where.push(eq(audit.actorAgentId, filter.agentId));
  if (filter.jobId) where.push(eq(audit.jobId, filter.jobId));
  if (filter.action) where.push(filter.action.includes(".") ? eq(audit.action, filter.action as never) : like(audit.action, `${filter.action}.%`));
  if (filter.resourceType) where.push(eq(audit.resourceType, filter.resourceType));
  if (filter.resourceId) where.push(eq(audit.resourceId, filter.resourceId));
  if (filter.result) where.push(eq(audit.result, filter.result));
  if (filter.from) where.push(gte(audit.at, new Date(filter.from)));
  if (filter.to) where.push(lte(audit.at, new Date(filter.to)));
  if (cursor) {
    const after = decode(cursor);
    where.push(sql`(${audit.at}, ${audit.id}) < (${after.at}::timestamptz, ${after.id})`);
  }
  const rows = await db
    .select({ row: audit, at: sql<string>`to_char(${audit.at} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, agentName: jobAgentNameSql })
    .from(audit)
    .leftJoin(agents, and(eq(agents.id, audit.actorAgentId), eq(agents.ownerId, ownerId)))
    // A Job actor's run: its agent's name once the agent was deleted (`runs.agent_name`).
    .leftJoin(runs, and(eq(runs.id, sql`${audit.actor}->>'runId'`), eq(runs.ownerId, ownerId)))
    .where(and(...where))
    .orderBy(desc(audit.at), desc(audit.id))
    .limit(AUDIT_PAGE + 1);
  const page = rows.slice(0, AUDIT_PAGE);
  const last = page.at(-1);
  return {
    rows: page.map(({ row, at, agentName }) => ({ ...row, at, agentName })),
    next: rows.length > AUDIT_PAGE && last ? Buffer.from(JSON.stringify({ at: last.at, id: last.row.id })).toString("base64url") : null,
  };
}
