import { call } from "@orpc/server";
import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { audit, organizations } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { router } from "../rpc/router.ts";
import { ownerContext, personContext, secondWorkspace } from "../runners/test-support.ts";
import type { AuditAction } from "./model.ts";

type Ctx = Awaited<ReturnType<typeof ownerContext>>;

const row = (context: Ctx, at: string, action: AuditAction, details: Record<string, string> = {}, workspaceId = context.workspaceId) => ({
  id: newId("aud"),
  workspaceId,
  ownerId: context.ownerId,
  at: new Date(at),
  actor: { type: "job" as const, runId: "run_1" },
  jobId: "run_1",
  action,
  resourceType: action.startsWith("job.") ? ("job" as const) : ("question" as const),
  resourceId: "x",
  result: "ok" as const,
  details,
});

const zero = { jobsFinished: 0, jobsFailed: 0, questionsAsked: 0, approvalsGranted: 0, approvalsDenied: 0 };

test("audit.daily counts Jobs ended, questions asked and approvals answered per day, where the zone's days start, zero days included", async () => {
  const context = await ownerContext();
  const { a, b } = await secondWorkspace(context);
  await context.db.insert(audit).values([
    // In Tokyo (UTC+9) the 28th's evening is already the 1st.
    row(context, "2026-02-28T20:00:00Z", "job.finished"),
    row(context, "2026-03-01T10:00:00Z", "job.finished"),
    row(context, "2026-03-01T20:00:00Z", "job.failed"),
    row(context, "2026-03-02T12:00:00Z", "question.asked", { questionKind: "question" }),
    // An approval asked is counted when it is answered; a question's answer isn't an approval's.
    row(context, "2026-03-02T12:00:00Z", "question.asked", { questionKind: "approval" }),
    row(context, "2026-03-02T16:00:00Z", "question.answered", { questionKind: "approval", decision: "allow" }),
    row(context, "2026-03-03T01:00:00Z", "question.answered", { questionKind: "approval", decision: "allow-always" }),
    row(context, "2026-03-03T02:00:00Z", "question.answered", { questionKind: "approval", decision: "deny" }),
    row(context, "2026-03-03T03:00:00Z", "question.answered", { questionKind: "question", decision: "text" }),
    row(context, "2026-03-03T04:00:00Z", "job.started"),
    // Another workspace's row is never counted, and nor is a day past the range.
    row(context, "2026-03-02T12:00:00Z", "job.finished", {}, b.workspaceId),
    row(context, "2026-03-05T12:00:00Z", "job.finished"),
  ]);
  const daily = (timeZone: string) => call(router.audit.daily, { from: "2026-03-01", to: "2026-03-04", timeZone }, { context: a });

  expect(await daily("UTC")).toEqual({
    timeZone: "UTC",
    days: [
      { date: "2026-03-01", counts: { ...zero, jobsFinished: 1, jobsFailed: 1 } },
      { date: "2026-03-02", counts: { ...zero, questionsAsked: 1, approvalsGranted: 1 } },
      { date: "2026-03-03", counts: { ...zero, approvalsGranted: 1, approvalsDenied: 1 } },
      { date: "2026-03-04", counts: zero },
    ],
  });
  expect(await daily("Asia/Tokyo")).toEqual({
    timeZone: "Asia/Tokyo",
    days: [
      { date: "2026-03-01", counts: { ...zero, jobsFinished: 2 } },
      { date: "2026-03-02", counts: { ...zero, jobsFailed: 1, questionsAsked: 1 } },
      { date: "2026-03-03", counts: { ...zero, approvalsGranted: 2, approvalsDenied: 1 } },
      { date: "2026-03-04", counts: zero },
    ],
  });
});

test("audit.daily takes a range of at most the organization's retention, a zone's name and a manager", async () => {
  const context = await ownerContext();
  await context.db
    .update(organizations)
    .set({ auditRetentionDays: 3 })
    .where(sql`true`);
  const daily = (input: { from: string; to: string; timeZone: string }, as: Ctx = context) => call(router.audit.daily, input, { context: as });
  expect((await daily({ from: "2026-03-01", to: "2026-03-03", timeZone: "Europe/Paris" })).days).toHaveLength(3);
  for (const range of [
    { from: "2026-03-01", to: "2026-03-04" },
    { from: "2026-03-02", to: "2026-03-01" },
  ])
    await expect(daily({ ...range, timeZone: "UTC" })).rejects.toMatchObject({ code: "BAD_REQUEST", data: { key: "audit.dailyRange" } });
  // An offset isn't a zone: the database would read its sign the other way.
  for (const timeZone of ["+09:00", "Mars/Olympus", ""])
    await expect(daily({ from: "2026-03-01", to: "2026-03-01", timeZone })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(daily({ from: "2026-03-01", to: "2026-03-01", timeZone: "UTC" }, await personContext(context, "mia", "member"))).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});

test("a day follows its zone's rules: summer time under an alias, and a midnight that comes twice", async () => {
  const context = await ownerContext();
  await context.db.insert(audit).values([
    // 00:30 on 2 July in Brussels, whose rules `CET` names (summer time, UTC+2), not a fixed UTC+1.
    row(context, "2026-07-01T22:30:00Z", "job.finished"),
    // 00:30 on 2 November in Havana, before its clocks go back from 01:00 to midnight.
    row(context, "2025-11-02T04:30:00Z", "job.failed"),
  ]);
  const daily = (from: string, to: string, timeZone: string) => call(router.audit.daily, { from, to, timeZone }, { context });
  expect((await daily("2026-07-01", "2026-07-02", "CET")).days).toEqual([
    { date: "2026-07-01", counts: zero },
    { date: "2026-07-02", counts: { ...zero, jobsFinished: 1 } },
  ]);
  expect((await daily("2025-11-02", "2025-11-02", "America/Havana")).days).toEqual([{ date: "2025-11-02", counts: { ...zero, jobsFailed: 1 } }]);
});

test("every zone name the runtime lists is one the database knows", async () => {
  const context = await ownerContext();
  const zones = Intl.supportedValuesOf("timeZone");
  const unknown = await context.db.execute(
    sql`select z from unnest(${`{${zones.join(",")}}`}::text[]) z where lower(z) not in (select lower(name) from pg_timezone_names)`,
  );
  expect((unknown as unknown as { rows: unknown[] }).rows).toEqual([]);
});
