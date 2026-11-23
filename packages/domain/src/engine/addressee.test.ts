import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { agents, organizationMembers, runs, user, workspaceMembers } from "../db/schema.ts";
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
