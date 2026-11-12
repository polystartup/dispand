import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { audit } from "../db/schema.ts";
import { ownerContext } from "../runners/test-support.ts";
import { recordToolCall } from "./tool-call.ts";

test("a tool call's row says how it ended: ok, an error the tool reported, a call that failed, a refusal", async () => {
  const { db, ownerId } = await ownerContext();
  const job = { ownerId, runId: "run_1", agentId: "agent_1" };
  const tool = { id: "tool_1", name: "GitHub" };
  await recordToolCall(db, job, tool, "create_issue", { ok: true, result: { isError: false } });
  await recordToolCall(db, job, tool, "create_issue", { ok: true, result: { isError: true } });
  await recordToolCall(db, job, tool, "create_issue", { ok: false });
  await recordToolCall(db, job, tool, "create_issue", "not-approved");
  const rows = await db.select().from(audit).where(eq(audit.ownerId, ownerId)).orderBy(audit.at, audit.id);
  expect(rows.map((r) => [r.result, r.details.reason ?? null])).toEqual([
    ["ok", null],
    ["failed", "tool-error"],
    ["failed", "call-failed"],
    ["refused", "not-approved"],
  ]);
});
