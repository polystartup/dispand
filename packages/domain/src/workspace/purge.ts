import { and, eq, isNotNull, notExists, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { organizationMembers, organizations, user } from "../db/schema.ts";
import { inScope, SYSTEM } from "../db/scope.ts";
import { errorKind } from "../log.ts";
import { currentTraceId, inSpan, meter, tracer } from "../telemetry/index.ts";

const traces = tracer("people");

/** A person who belongs to no organization: only they are purged (an archive may race an acceptance elsewhere). */
const notInOrganization = notExists(sql`(select 1 from ${organizationMembers} where ${organizationMembers.userId} = ${user.id})`);
const counts = meter("people");

/** The retention of a person whose archiving organization is gone (as an organization's default). */
export const DEFAULT_PERSON_RETENTION_DAYS = 90;

/**
 * Permanently deletes the people archived longer than their archiving organization's retention
 * (`organizations.person_retention_days`, read now). Deleting a person deletes their identity,
 * memberships, push devices, pages and Assistant with its chats (`dispand_person_deleted()`);
 * everything else they made stays with no author. Each deletion is recorded in the archiving
 * organization's workspaces. Runs once a night.
 */
export async function purgeArchivedPeople(dbs: { db: Db }, now: Date): Promise<{ purged: number }> {
  return inSpan(traces, "people.purge", {}, errorKind, async (span) => {
    const days = sql`coalesce(${organizations.personRetentionDays}, ${DEFAULT_PERSON_RETENTION_DAYS})`;
    const pastRetention = and(isNotNull(user.archivedAt), sql`${user.archivedAt} < ${now.toISOString()}::timestamptz - make_interval(days => ${days})`);
    const due = await inScope(SYSTEM, () => dbs.db.select({ id: user.id, archivedBy: user.archivedBy }).from(user)
      .leftJoin(organizations, eq(organizations.id, user.archivedBy))
      .where(and(notInOrganization, pastRetention)));
    let purged = 0;
    for (const person of due) {
      // The definer function deletes and records, re-checking that the person may be purged (`dispand_purge_person`).
      const result = await inScope(SYSTEM, () => dbs.db.execute(sql`select dispand_purge_person(${person.id}, ${currentTraceId() ?? null}) as purged`));
      if ((result as unknown as { rows: { purged: boolean }[] }).rows[0]?.purged) purged++;
    }
    span.setAttribute("dispand.people.purged", purged);
    if (purged > 0) counts.counter("dispand.people.purged").add(purged);
    return { purged };
  });
}
