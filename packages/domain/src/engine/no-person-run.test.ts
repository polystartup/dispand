import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { agents, runs, stepRuns, user } from "../db/schema.ts";
import { jobOfToken, jobTokenOf } from "../platform/token.ts";
import { jobIdentity, ownerContext } from "../runners/test-support.ts";
import { sessionTooling } from "./tooling.ts";

// An agent's unattended Job may record no person (`runs.owner_id` null); nothing writes one yet,
// so these tests seed the row.

test("a Job with no person gets no Job identity, so no tools of Dispand's", async () => {
  const context = await ownerContext();
  const { runId } = await jobIdentity(context);
  const [run] = await context.db.select().from(runs).where(eq(runs.id, runId));
  const token = jobTokenOf(context.secrets, run!)!;
  expect(await jobOfToken(context.db, token)).toMatchObject({ runId });
  await context.db.update(runs).set({ ownerId: null }).where(eq(runs.id, runId));
  expect(await jobOfToken(context.db, token)).toBeNull();
});

test("a Job with no person keeps its files in its agent's creator's folder and records no person", async () => {
  const context = await ownerContext();
  const { runId, agentId } = await jobIdentity(context);
  await context.db.insert(user).values({ id: "user_bo", name: "Bo", email: "bo@example.com" });
  await context.db.update(agents).set({ ownerId: "user_bo" }).where(eq(agents.id, agentId));
  await context.db.update(runs).set({ ownerId: null }).where(eq(runs.id, runId));
  const [step] = await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId)).limit(1);
  const sessionId = step!.sessionId ?? "ses_x";
  if (!step!.sessionId) await context.db.update(stepRuns).set({ sessionId }).where(eq(stepRuns.id, step!.id));
  expect(await sessionTooling(context.db, sessionId)).toMatchObject({ jobId: runId, jobOwnerId: null, filesOwnerId: "user_bo" });
});
