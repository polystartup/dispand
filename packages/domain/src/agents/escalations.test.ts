import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { agentEscalations, organizationMembers, user, workspaceMembers, workspaces } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext, runnerWithClis } from "../runners/test-support.ts";
import { escalationRights, escalationsOf, MAX_ESCALATIONS, members } from "./escalations.ts";

async function setup() {
  const context = await ownerContext();
  const { runnerId } = await runnerWithClis(context);
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const base = { harnessId: harness.id, systemPrompt: "", skillPackageIds: [], toolIds: [] };
  const [ws] = await context.db.select().from(workspaces).where(eq(workspaces.id, context.workspaceId));
  /** A person of the organization, a member of `workspaceId` (this one by default), with a profile or none. */
  const person = async (id: string, name: string, description: string | null, workspaceId: string | null = context.workspaceId) => {
    await context.db.insert(user).values({ id, name, email: `${id}@example.com`, description });
    await context.db.insert(organizationMembers).values({ organizationId: ws!.organizationId, userId: id, role: "member" });
    if (workspaceId) await context.db.insert(workspaceMembers).values({ workspaceId, userId: id, role: "member" });
  };
  const agent = (fields: Record<string, unknown> = {}) => call(router.agents.create, { ...base, name: "Clerk", ...fields }, { context });
  return { context, base, ws: ws!, person, agent };
}

describe("escalation modes", () => {
  test("a new agent starts disabled and offers nobody; the mode, picks and preference are saved, given back, and kept when an update leaves them out", async () => {
    const s = await setup();
    await s.person("user_ann", "Ann", "Sales, EU.");
    const clerk = await s.agent();
    expect(clerk).toMatchObject({ escalateMode: "disabled", preferAgents: false });
    expect(await escalationRights(s.context.db, clerk.id)).toEqual([]);
    await call(router.agents.update, { ...s.base, id: clerk.id, name: "Clerk", escalateMode: "whitelist", escalations: [{ userId: "user_ann" }], preferAgents: true }, { context: s.context });
    await call(router.agents.update, { ...s.base, id: clerk.id, name: "Clerk" }, { context: s.context });
    const got = await call(router.agents.get, { id: clerk.id }, { context: s.context });
    expect(got).toMatchObject({ escalateMode: "whitelist", preferAgents: true, escalations: [{ userId: "user_ann", name: "Ann", member: true, profile: true }] });
    // Disabled keeps the picks, and offers nobody.
    await call(router.agents.update, { ...s.base, id: clerk.id, name: "Clerk", escalateMode: "disabled" }, { context: s.context });
    expect(await escalationRights(s.context.db, clerk.id)).toEqual([]);
    expect(await escalationsOf(s.context.db, clerk.id)).toHaveLength(1);
  });

  test("a pick who isn't a member is refused; the organization owner may be picked", async () => {
    const s = await setup();
    await s.person("user_out", "Out", "Elsewhere.", null);
    const clerk = await s.agent();
    await expect(call(router.agents.update, { ...s.base, id: clerk.id, name: "Clerk", escalations: [{ userId: "user_out" }] }, { context: s.context })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Only a member of this workspace can be picked.",
    });
    await call(router.agents.update, { ...s.base, id: clerk.id, name: "Clerk", escalateMode: "whitelist", escalations: [{ userId: s.context.ownerId }] }, { context: s.context });
    expect((await escalationRights(s.context.db, clerk.id)).map((p) => p.id)).toEqual([s.context.ownerId]);
  });

  test("a whitelisted person who left is kept, shown so, and skipped", async () => {
    const s = await setup();
    await s.person("user_ann", "Ann", "Sales.");
    await s.person("user_bob", "Bob", null);
    const clerk = await s.agent({ escalateMode: "whitelist", escalations: [{ userId: "user_ann" }, { userId: "user_bob" }] });
    await s.context.db.delete(workspaceMembers).where(eq(workspaceMembers.userId, "user_ann"));
    expect(await escalationsOf(s.context.db, clerk.id)).toEqual([
      { userId: "user_ann", name: "Ann", member: false, profile: true },
      { userId: "user_bob", name: "Bob", member: true, profile: false },
    ]);
    // A whitelisted person with no profile is still offered: they were picked.
    expect((await escalationRights(s.context.db, clerk.id)).map((p) => p.id)).toEqual(["user_bob"]);
    // Saving the agent with the list as it is keeps the one who left.
    await call(router.agents.update, { ...s.base, id: clerk.id, name: "Clerk", escalations: [{ userId: "user_ann" }, { userId: "user_bob" }] }, { context: s.context });
    expect(await s.context.db.select({ id: agentEscalations.userId }).from(agentEscalations)).toHaveLength(2);
  });

  test("auto skips members with no profile, who stay members, and caps at 50 by name", async () => {
    const s = await setup();
    await s.person("user_ann", "Ann", "Sales.");
    await s.person("user_bob", "Bob", "");
    await s.person("user_cid", "Cid", null);
    const clerk = await s.agent({ escalateMode: "auto" });
    expect((await escalationRights(s.context.db, clerk.id)).map((p) => p.name)).toEqual(["Ann"]);
    expect((await members(s.context.db, s.context.workspaceId)).map((p) => p.id)).toEqual(expect.arrayContaining(["user_ann", "user_bob", "user_cid", s.context.ownerId]));
    for (let i = 0; i < MAX_ESCALATIONS + 1; i++) await s.person(`user_${i}`, `Z ${String(i).padStart(2, "0")}`, "Knows things.");
    const offered = await escalationRights(s.context.db, clerk.id);
    expect(offered).toHaveLength(MAX_ESCALATIONS);
    expect(offered[0]!.name).toBe("Ann");
  });

  test("auto lists no member of another workspace", async () => {
    const s = await setup();
    // Made first: with two workspaces, a request names which one it works in.
    const clerk = await s.agent({ escalateMode: "auto" });
    await s.context.db.insert(workspaces).values({ id: "ws_b", organizationId: s.ws.organizationId });
    await s.person("user_b", "Bea", "Knows workspace B.", "ws_b");
    expect((await escalationRights(s.context.db, clerk.id)).map((p) => p.id)).not.toContain("user_b");
    expect((await members(s.context.db, s.context.workspaceId)).map((p) => p.id)).not.toContain("user_b");
  });

  test("agents.people lists members with whether they wrote a profile, never its text", async () => {
    const s = await setup();
    await s.person("user_ann", "Ann", "sentinel-profile-text");
    const people = await call(router.agents.people, undefined, { context: s.context });
    expect(people).toContainEqual({ id: "user_ann", name: "Ann", profile: true });
    expect(JSON.stringify(people)).not.toContain("sentinel-profile-text");
  });
});
