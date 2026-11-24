import { call } from "@orpc/server";
import { expect, test } from "vitest";
import { ownerContext, personContext, runnerWithClis } from "../runners/test-support.ts";
import { eq } from "drizzle-orm";
import { runs, workspaceMembers } from "../db/schema.ts";
import { router } from "./router.ts";

const forbidden = { code: "FORBIDDEN" };

test("levels › a member reads the workspace's settings and can't change them; a manager changes all but the files limit", async () => {
  const owner = await ownerContext();
  const pat = await personContext(owner, "pat", "member");
  const mia = await personContext(owner, "mia", "manager");
  await expect(call(router.workspace.checkpoint, undefined, { context: pat })).resolves.toMatchObject({ checkpoint: expect.any(Number) });
  await expect(call(router.workspace.strictPermissions, undefined, { context: pat })).resolves.toMatchObject({ strict: false });
  await expect(call(router.workspace.setCheckpoint, { checkpoint: 5 }, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.workspace.setStrictPermissions, { strict: true }, { context: pat })).rejects.toMatchObject(forbidden);
  await call(router.workspace.setCheckpoint, { checkpoint: 5 }, { context: mia });
  await call(router.workspace.setStrictPermissions, { strict: true }, { context: mia });
  expect(await call(router.workspace.checkpoint, undefined, { context: pat })).toEqual({ checkpoint: 5 });
  // The files limit is the organization's: its owner's only.
  await expect(call(router.workspace.setFilesLimit, { mib: 10 }, { context: mia })).rejects.toMatchObject(forbidden);
  await expect(call(router.workspace.setFilesLimit, { mib: 10 }, { context: owner })).resolves.toEqual({ mib: 10 });
});

test("levels › the Audit is a manager's to read; each person's devices are theirs", async () => {
  const owner = await ownerContext();
  const pat = await personContext(owner, "pat", "member");
  const mia = await personContext(owner, "mia", "manager");
  await expect(call(router.audit.list, {}, { context: pat })).rejects.toMatchObject(forbidden);
  await expect(call(router.audit.list, {}, { context: mia })).resolves.toMatchObject({ rows: expect.any(Array) });
  const subscription = { endpoint: "https://push.example.com/pat", keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" }, language: "en" as const };
  await call(router.push.subscribe, subscription, { context: pat });
  expect((await call(router.push.list, undefined, { context: owner })).devices).toEqual([]);
});

test("levels › a Job has its person's rights, read at each call: it reads the Audit only while that person manages", async () => {
  const owner = await ownerContext();
  const { runnerId } = await runnerWithClis(owner);
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context: owner });
  const agent = await call(router.agents.create, { name: "Auditor", harnessId: harness.id, systemPrompt: "", bundles: ["configure"] }, { context: owner });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context: owner });
  const mia = await personContext(owner, "mia", "manager");
  const pat = await personContext(owner, "pat", "member");
  const jobOf = async (person: typeof mia) => ({ runId: (await call(router.jobs.start, { triggerId: trigger.id }, { context: person })).runId, ownerId: person.ownerId, workspaceId: owner.workspaceId, agentId: agent.id });
  const asManager = await jobOf(mia);
  const asMember = await jobOf(pat);
  const read = (job: Awaited<ReturnType<typeof jobOf>>) => call(router.audit.list, {}, { context: { ...owner, job } });
  await expect(read(asManager)).resolves.toMatchObject({ rows: expect.any(Array) });
  await expect(read(asMember)).rejects.toMatchObject(forbidden);
  // Demoted, the person's Jobs lose the right at their next call.
  await owner.db.update(workspaceMembers).set({ role: "member" }).where(eq(workspaceMembers.userId, "mia"));
  await expect(read(asManager)).rejects.toMatchObject(forbidden);
});

test("levels › a Job fired by a trigger has no person's rights, but a person's Assistant has its person's", async () => {
  const owner = await ownerContext();
  const { runnerId } = await runnerWithClis(owner);
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context: owner });
  const agent = await call(router.agents.create, { name: "Auditor", harnessId: harness.id, systemPrompt: "", bundles: ["configure"] }, { context: owner });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context: owner });
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context: owner });
  const read = (job: { runId: string; ownerId: string; workspaceId: string; agentId: string }) => call(router.audit.list, {}, { context: { ...owner, job } });
  const job = { runId, ownerId: owner.ownerId, workspaceId: owner.workspaceId, agentId: agent.id };
  await expect(read(job)).resolves.toMatchObject({ rows: expect.any(Array) });
  // The same Job, as a schedule would have fired it: the trigger's author started nothing.
  await owner.db.update(runs).set({ cause: { kind: "schedule", depth: 0 } as never }).where(eq(runs.id, runId));
  await expect(read(job)).rejects.toMatchObject(forbidden);
  // A person's Assistant, its scheduled review included, keeps its person's rights.
  const assistant = await call(router.agents.ensureAssistant, { harnessId: harness.id }, { context: owner });
  await owner.db.update(runs).set({ agentId: assistant.agentId }).where(eq(runs.id, runId));
  await expect(read({ ...job, agentId: assistant.agentId })).resolves.toMatchObject({ rows: expect.any(Array) });
});
