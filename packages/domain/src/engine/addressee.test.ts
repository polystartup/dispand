import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { agents, organizationMembers, questions, runs, user, workspaceMembers } from "../db/schema.ts";
import { jobIdentity, ownerContext } from "../runners/test-support.ts";
import { addresseeOf } from "./addressee.ts";

test("a run's question goes to its person; with none, to its agent's creator, then the organization's owner once the creator lost the workspace", async () => {
  const context = await ownerContext();
  const { db, organizationId, workspaceId } = context;
  const { runId, agentId } = await jobIdentity(context);
  expect(await addresseeOf(db, runId)).toBe(context.ownerId);
  // An unattended Job: no person. Its agent was made by Bo, a member of the workspace.
  await db.insert(user).values({ id: "user_bo", name: "Bo", email: "bo@example.com" });
  await db.insert(organizationMembers).values({ organizationId, userId: "user_bo", role: "member" });
  await db.insert(workspaceMembers).values({ workspaceId, userId: "user_bo", role: "member" });
  await db.update(agents).set({ ownerId: "user_bo" }).where(eq(agents.id, agentId));
  await db.update(runs).set({ ownerId: null }).where(eq(runs.id, runId));
  expect(await addresseeOf(db, runId)).toBe("user_bo");
  // Removed from the workspace, kept in the organization: the organization's owner.
  await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, "user_bo"));
  expect(await addresseeOf(db, runId)).toBe(context.ownerId);
});

test("an archived person is gone for routing: their run's questions and those waiting on them go to whom comes next", async () => {
  const context = await ownerContext();
  const { db, organizationId, workspaceId } = context;
  const { runId, agentId } = await jobIdentity(context);
  await db.insert(user).values({ id: "user_bo", name: "Bo", email: "bo@example.com" });
  await db.insert(organizationMembers).values({ organizationId, userId: "user_bo", role: "member" });
  await db.insert(workspaceMembers).values({ workspaceId, userId: "user_bo", role: "member" });
  await db.update(agents).set({ ownerId: "user_bo" }).where(eq(agents.id, agentId));
  await db.update(runs).set({ ownerId: "user_bo" }).where(eq(runs.id, runId));
  await db.insert(questions).values({ id: "q_bo", ownerId: "user_bo", addresseeId: "user_bo", runId, placement: "notifications", kind: "question", payload: { kind: "choice", questions: [] } as never, status: "pending" });
  expect(await addresseeOf(db, runId)).toBe("user_bo");
  await db.update(user).set({ archivedAt: new Date() }).where(eq(user.id, "user_bo"));
  expect(await addresseeOf(db, runId)).toBe(context.ownerId);
  expect(await context.engine.sweepEscalations(new Date())).toBe(1);
  expect(await db.select({ addresseeId: questions.addresseeId }).from(questions).where(eq(questions.id, "q_bo"))).toEqual([{ addresseeId: context.ownerId }]);
});
