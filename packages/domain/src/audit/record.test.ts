import { randomBytes } from "node:crypto";
import { asc } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { audit, user } from "../db/schema.ts";
import { createSecretBox } from "../secrets.ts";
import { testDb } from "../runners/test-support.ts";
import { tracer } from "../telemetry/index.ts";
import { captureTelemetry } from "../telemetry/testing.ts";
import { type AuditEntry, MAX_DETAILS, recordAudit, recordAuditAfter } from "./record.ts";

async function owner() {
  const db = await testDb();
  await db.insert(user).values({ id: "user_1", name: "Ada", email: "ada@example.com" });
  return db;
}

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  ownerId: "user_1",
  actor: { type: "user", userId: "user_1" },
  agentId: null,
  jobId: "run_1",
  action: "job.created",
  resource: { type: "job", id: "run_1" },
  ...over,
});
const rows = (db: Awaited<ReturnType<typeof owner>>) => db.select().from(audit).orderBy(asc(audit.at));

test("an unknown details key, action, resource or actor is refused, and nothing is written", async () => {
  const db = await owner();
  await expect(recordAudit(db, entry({ details: { prompt: "Write a poem" } as never }))).rejects.toThrow();
  await expect(recordAudit(db, entry({ action: "job.deleted" as never }))).rejects.toThrow();
  await expect(recordAudit(db, entry({ resource: { type: "message" as never, id: "m" } }))).rejects.toThrow();
  await expect(recordAudit(db, entry({ actor: { type: "step", runId: "run_1", stepId: "s" } as never }))).rejects.toThrow();
  // A kind is a code, never words; an id is an id.
  await expect(recordAudit(db, entry({ details: { reason: "The tool said: no" } }))).rejects.toThrow();
  await expect(recordAudit(db, entry({ details: { tableId: "a table name with spaces" } }))).rejects.toThrow();
  expect(await rows(db)).toEqual([]);
});

test("a long name is cut at 200 characters, and the details at 2,000", async () => {
  const db = await owner();
  await recordAudit(db, entry({ details: { agentName: "a".repeat(300) } }));
  const names = { agentName: "a".repeat(300), harnessName: "h".repeat(300), runnerName: "r".repeat(300), triggerName: "t".repeat(300), toolName: "o".repeat(300), tableName: "b".repeat(300) };
  await recordAudit(db, entry({ details: { ...names, harnessName: "h".repeat(300) }, jobId: "run_2" }));
  await recordAudit(db, entry({ details: { ...names, agentId: "agent_1", item: 3 }, jobId: "run_3" }));
  const [one, two, three] = await rows(db);
  expect(one!.details).toEqual({ agentName: "a".repeat(200) });
  for (const r of [two!, three!]) {
    expect(JSON.stringify(r.details).length).toBeLessThanOrEqual(MAX_DETAILS);
    for (const value of Object.values(r.details)) if (typeof value === "string") expect(value.length).toBeLessThanOrEqual(200);
  }
  // Keys are dropped from the end, the first ones kept whole.
  expect(three!.details).toMatchObject({ agentId: "agent_1", agentName: "a".repeat(200) });
});

test("a value equal to a secret the process opened is dropped", async () => {
  const db = await owner();
  const box = createSecretBox(randomBytes(32));
  const secret = "sk-audit-sentinel-0123456789";
  expect(box.open(box.seal(secret, "tools:t1:headers"), "tools:t1:headers")).toBe(secret);
  await recordAudit(db, entry({ resource: { type: "job", id: secret }, details: { toolName: secret, agentName: "Writer" } }));
  const [row] = await rows(db);
  expect(row).toMatchObject({ resourceId: null, details: { agentName: "Writer" } });
  expect(JSON.stringify(row)).not.toContain(secret);
});

test("a row carries the trace it was written in, and a Job actor's agent", async () => {
  const db = await owner();
  const telemetry = await captureTelemetry();
  onTestFinished(telemetry.stop);
  let traceId = "";
  await tracer("test").startActiveSpan("work", async (span) => {
    traceId = span.spanContext().traceId;
    await recordAudit(db, entry());
    span.end();
  });
  await recordAudit(db, entry({ jobId: "run_2" }));
  const [inSpan, outside] = await rows(db);
  expect(inSpan!.traceId).toBe(traceId);
  expect(outside!.traceId).toBeNull();
  const points = await telemetry.metrics();
  expect(points).toContainEqual({ name: "dispand.audit.rows", attributes: { "dispand.audit.action": "job.created", "dispand.result": "ok" } });
});

test("a write after the fact never throws: its failure is logged and counted", async () => {
  const db = await owner();
  const telemetry = await captureTelemetry();
  onTestFinished(telemetry.stop);
  const insert = vi.spyOn(db, "insert").mockImplementationOnce(() => {
    throw new Error("insert failed: secret text");
  });
  await expect(recordAuditAfter(db, entry())).resolves.toBeUndefined();
  insert.mockRestore();
  expect(await rows(db)).toEqual([]);
  expect(telemetry.logs().map((r) => r.body)).toContain("audit write failed");
  expect(await telemetry.metrics()).toContainEqual({ name: "dispand.audit.rows", attributes: { "dispand.audit.action": "job.created", "dispand.result": "failed" } });
  expect(await telemetry.all()).not.toContain("secret text");
});
