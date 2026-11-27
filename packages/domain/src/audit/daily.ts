import { and, eq, gte, inArray, lt, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { audit } from "../db/schema.ts";
import type { TableScope } from "../platform/bundles.ts";
import { knownTimezone } from "../workflows/schedule.ts";
import { jobView } from "./list.ts";

/**
 * A range of days, both ends included, on the calendar of `timeZone`: a zone's name (an offset
 * such as `+01:00` isn't one, as the database would read its sign the other way). The database
 * gets the name `Intl` resolves it to, so both read the same zone (`CET` is Brussels' rules,
 * where the database's abbreviation would be a fixed offset).
 */
export const DailyRange = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  timeZone: z
    .string()
    .max(64)
    .refine((zone) => /^[A-Za-z]/.test(zone) && knownTimezone(zone), "workflows.schedule.unknownTimezone"),
});
export type DailyRange = z.infer<typeof DailyRange>;

/** A day's counts of Audit rows: how many Jobs ended, and how often agents stopped to ask. */
export type DailyCounts = { jobsFinished: number; jobsFailed: number; questionsAsked: number; approvalsGranted: number; approvalsDenied: number };

const DAY_MS = 86_400_000;
const dayOf = (date: string) => Date.parse(`${date}T00:00:00Z`);

/** How many days the range has, both ends included: 0 or less when it ends before it starts. */
export const daysIn = (range: { from: string; to: string }) => (dayOf(range.to) - dayOf(range.from)) / DAY_MS + 1;

const COUNTED = ["job.finished", "job.failed", "question.asked", "question.answered"] as const;
const kind = sql`${audit.details}->>'questionKind'`;
const decision = sql`${audit.details}->>'decision'`;
const counted = (where: SQL) => sql<number>`(count(*) filter (where ${where}))::int`;

/**
 * The workspace's Audit rows counted per day of the range, each day starting at midnight in its
 * zone, every day of it listed (none counted: zeros). The rows a list of `tables`' Job reads
 * (`jobView`). Counts only: no row's id, name or trace. The range is bounded by the caller.
 */
export async function dailyAudit(db: Db, workspaceId: string, range: DailyRange, tables: TableScope): Promise<{ date: string; counts: DailyCounts }[]> {
  const { from, to } = range;
  const timeZone = new Intl.DateTimeFormat("en-US", { timeZone: range.timeZone }).resolvedOptions().timeZone;
  const rows = await db
    .select({
      date: sql<string>`to_char(${audit.at} at time zone ${timeZone}, 'YYYY-MM-DD')`,
      jobsFinished: counted(sql`${audit.action} = 'job.finished'`),
      jobsFailed: counted(sql`${audit.action} = 'job.failed'`),
      questionsAsked: counted(sql`${audit.action} = 'question.asked' and ${kind} = 'question'`),
      approvalsGranted: counted(sql`${audit.action} = 'question.answered' and ${kind} = 'approval' and ${decision} in ('allow', 'allow-always')`),
      approvalsDenied: counted(sql`${audit.action} = 'question.answered' and ${kind} = 'approval' and ${decision} = 'deny'`),
    })
    .from(audit)
    .where(
      and(
        eq(audit.workspaceId, workspaceId),
        inArray(audit.action, [...COUNTED]),
        // A day past each end: a zone's midnight may come twice (a clock set back at midnight), and
        // the database takes the later one. Only the range's days are kept below.
        gte(audit.at, sql`(${from}::date - 1)::timestamp at time zone ${timeZone}`),
        lt(audit.at, sql`(${to}::date + 2)::timestamp at time zone ${timeZone}`),
        ...jobView(tables),
      ),
    )
    // By position: the day's expression holds a parameter, which the database wouldn't match twice.
    .groupBy(sql`1`);
  const byDate = new Map(rows.map(({ date, ...counts }) => [date, counts]));
  return Array.from({ length: daysIn(range) }, (_, i) => {
    const date = new Date(dayOf(from) + i * DAY_MS).toISOString().slice(0, 10);
    return { date, counts: byDate.get(date) ?? { jobsFinished: 0, jobsFailed: 0, questionsAsked: 0, approvalsGranted: 0, approvalsDenied: 0 } };
  });
}
