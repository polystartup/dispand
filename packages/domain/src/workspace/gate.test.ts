import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { call, ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { refusalOf, refuses, setTenancy, tenancyOf } from "../db/scope.ts";
import { JOB_STEP } from "../engine/job-def.ts";
import { artifacts, audit, messages, organizationMembers, organizations, runs, stepRuns, tools as toolsTable, user, workspaceInvitations, workspaceMembers, workspaces } from "../db/schema.ts";
import { registerMessages } from "../messages/index.ts";
import { callPlatformTool, type JobIdentity } from "../platform/call.ts";
import { handleJobFiles } from "../platform/job-files.ts";
import { jobTokenOf } from "../platform/token.ts";
import { handleJobToolsMcp } from "../platform/tools-mcp.ts";
import { router } from "../rpc/router.ts";
import { approveAs, asCli, jobIdentity, ownerContext, personContext, refusing, runnerWithClis, testDb } from "../runners/test-support.ts";
import { installedToolCaller } from "../tools/cloud.ts";
import type { InstalledTools } from "../tools/executor.ts";
import { handleToolOAuthCallback } from "../tools/oauth.ts";
import { stateHash } from "../tools/oauth-store.ts";
import { startFakeMcp } from "../tools/test-server.ts";
import { ORGANIZATION_HEADER, WORKSPACE_HEADER } from "./authorize.ts";
import { organizationRefusal, workspaceRefusal } from "./gate.ts";

const LINK = "/organization-settings?organization=refused";
const REFUSED = "This organization can't be used right now.";

/**
 * The owner's organization (A), which `refuse` makes its install refuse until the test ends, and a
 * second organization of theirs (B) that it never refuses: the owner's requests pinned to each.
 */
async function setup() {
  const owner = await ownerContext();
  await owner.db.insert(organizations).values({ id: "org_b" });
  await owner.db.insert(workspaces).values({ id: "ws_b", organizationId: "org_b" });
  await owner.db.insert(organizationMembers).values({ organizationId: "org_b", userId: owner.ownerId, role: "owner" });
  const at = (organizationId: string, workspaceId: string, cookie = owner.headers.get("cookie")!) =>
    ({ ...owner, organizationId, workspaceId, headers: new Headers({ cookie, [ORGANIZATION_HEADER]: organizationId, [WORKSPACE_HEADER]: workspaceId }) });
  const a = at(owner.organizationId, owner.workspaceId);
  const b = at("org_b", "ws_b");
  /** The install refuses A with `key`: the public one by default. */
  const refuse = (key = "organization.refused") => refusing(owner.db, owner.organizationId, { key, link: LINK });
  const refusal = { code: "FORBIDDEN", message: REFUSED, data: { key: "organization.refused", link: LINK, organizationId: owner.organizationId } };
  return { owner, a, b, at, refuse, refusal };
}

/** A Job of A's, on a runner harness, of an agent with `fields` (bundles, tools), and what its platform tools answer. */
async function jobIn(context: Awaited<ReturnType<typeof setup>>["a"], fields: { bundles?: string[]; toolIds?: string[] } = {}) {
  const { runnerId } = await runnerWithClis(context);
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const agent = await call(router.agents.create, { name: "Builder", harnessId: harness.id, systemPrompt: "", ...fields } as never, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
  const job: JobIdentity = { runId, ownerId: context.ownerId, workspaceId: context.workspaceId, agentId: agent.id };
  return { harness, job, tool: (name: string, input: unknown = {}) => callPlatformTool(context, job, name, input) };
}

test("with no refusal on its tenancy, an install refuses no organization", async () => {
  const db = await testDb();
  // The database's tenancy as it splits work, without a refusal.
  const current = tenancyOf(db);
  setTenancy(db, { each: current.each, forRun: current.forRun });
  onTestFinished(() => setTenancy(db, current));
  expect([refuses(db), refusalOf(db, "org_refused"), organizationRefusal(db, "org_refused", "request")]).toEqual([false, undefined, undefined]);
  await db.insert(organizations).values({ id: "org_refused" });
  await db.insert(workspaces).values({ id: "ws_refused", organizationId: "org_refused" });
  expect(await workspaceRefusal(db, "ws_refused", "job_call")).toBeUndefined();
});

test("a refusal says the install's registered message, else the public one, with its link and organization", async () => {
  const db = await testDb();
  registerMessages("en", { "organization.testRefused": "This organization is paused by its install" });
  const lift = refusing(db, "org_refused", { key: "organization.testRefused", link: LINK });
  expect(refuses(db)).toBe(true);
  expect(refusalOf(db, "org_other")).toBeUndefined();
  expect(organizationRefusal(db, "org_other", "request")).toBeUndefined();
  expect(organizationRefusal(db, "org_refused", "request")).toMatchObject({
    code: "FORBIDDEN", message: "This organization is paused by its install", data: { key: "organization.testRefused", link: LINK, organizationId: "org_refused" },
  });
  lift();
  refusing(db, "org_refused", { key: "organization.unknownToThisServer", link: LINK });
  expect(organizationRefusal(db, "org_refused", "request")).toMatchObject({ code: "FORBIDDEN", message: REFUSED, data: { key: "organization.refused", link: LINK, organizationId: "org_refused" } });
  await db.insert(organizations).values([{ id: "org_refused" }, { id: "org_other" }]);
  await db.insert(workspaces).values([{ id: "ws_refused", organizationId: "org_refused" }, { id: "ws_other", organizationId: "org_other" }]);
  expect(await workspaceRefusal(db, "ws_refused", "job_call")).toMatchObject({ data: { organizationId: "org_refused" } });
  expect(await workspaceRefusal(db, "ws_other", "job_call")).toBeUndefined();
});

test("an admitted person's requests into a refused organization answer its refusal; another organization's keep working", async () => {
  const s = await setup();
  // No refusal yet: nothing changes.
  expect(await call(router.tables.list, undefined, { context: s.a })).toEqual([]);
  registerMessages("en", { "organization.testRefused": "This organization is paused by its install" });
  s.refuse("organization.testRefused");
  const registered = { code: "FORBIDDEN", message: "This organization is paused by its install", data: { key: "organization.testRefused", link: LINK, organizationId: s.a.organizationId } };
  await expect(call(router.tables.list, undefined, { context: s.a })).rejects.toMatchObject(registered);
  await expect(call(router.organization.directory, undefined, { context: s.a })).rejects.toMatchObject(registered);
  s.refuse("organization.unknownToThisServer");
  await expect(call(router.tables.list, undefined, { context: s.a })).rejects.toMatchObject(s.refusal);
  // With neither header, the person's only workspace is still into an organization.
  await s.owner.db.delete(organizationMembers).where(eq(organizationMembers.organizationId, "org_b"));
  await expect(call(router.tables.list, undefined, { context: { ...s.a, headers: new Headers({ cookie: s.a.headers.get("cookie")! }) } })).rejects.toMatchObject(s.refusal);
  await s.owner.db.insert(organizationMembers).values({ organizationId: "org_b", userId: s.owner.ownerId, role: "owner" });
  expect(await call(router.tables.list, undefined, { context: s.b })).toEqual([]);
  expect(await call(router.organization.directory, undefined, { context: s.b })).toBeDefined();
});

test("a person who isn't a member of the refused organization still gets NOT_FOUND there", async () => {
  const s = await setup();
  const { runId } = await jobIdentity(s.a);
  const bob = await personContext(s.owner, "bob", "member");
  // Bob belongs to B only.
  await s.owner.db.delete(workspaceMembers).where(eq(workspaceMembers.userId, "bob"));
  await s.owner.db.delete(organizationMembers).where(eq(organizationMembers.userId, "bob"));
  await s.owner.db.insert(organizationMembers).values({ organizationId: "org_b", userId: "bob", role: "member" });
  await s.owner.db.insert(workspaceMembers).values({ workspaceId: "ws_b", userId: "bob", role: "manager" });
  s.refuse();
  const naming = s.at(s.a.organizationId, s.a.workspaceId, bob.headers.get("cookie")!);
  const missing = { code: "NOT_FOUND", data: { key: "workspace.membershipNotFound" } };
  await expect(call(router.tables.list, undefined, { context: naming })).rejects.toMatchObject(missing);
  await expect(call(router.organization.directory, undefined, { context: naming })).rejects.toMatchObject(missing);
  await expect(call(router.workspace.people, { organizationId: s.a.organizationId, workspaceId: s.a.workspaceId }, { context: naming })).rejects.toMatchObject(missing);
  await expect(call(router.jobs.get, { id: runId }, { context: naming })).rejects.toMatchObject({ code: "NOT_FOUND" });
  // The owner, admitted there, gets the refusal; Bob's own organization keeps working.
  await expect(call(router.jobs.get, { id: runId }, { context: s.a })).rejects.toMatchObject(s.refusal);
  expect(await call(router.tables.list, undefined, { context: s.at("org_b", "ws_b", bob.headers.get("cookie")!) })).toEqual([]);
});

test("a Job's calls into a refused organization are tool errors, and an approved proposal item isn't used up", async () => {
  const s = await setup();
  const { harness, job, tool } = await jobIn(s.a, { bundles: ["configure", "data"] });
  const newAgent = { name: "Clerk", harnessId: harness.id, systemPrompt: "Be brief.", skillPackageIds: [], toolIds: [], bundles: ["data"], dataTables: "all" };
  const proposalId = ((await tool("propose", { items: [{ tool: "agents_create", input: newAgent }] })) as { output: { proposalId: string } }).output.proposalId;
  await approveAs(s.owner.db, proposalId, s.owner.ownerId);
  const allow = s.refuse();
  const refused = { ok: false, error: REFUSED };
  expect(await tool("rows_list", { tableId: "tbl_any" })).toEqual(refused);
  expect(await tool("agents_create", newAgent)).toEqual(refused);
  expect(await tool("proposal_apply", { proposalId })).toEqual(refused);
  // A procedure called for the Job itself is refused too.
  await expect(call(router.tables.list, undefined, { context: { ...s.a, job, headers: new Headers() } })).rejects.toMatchObject(s.refusal);
  // Allowed again: the approved item was never taken, and is made now.
  allow();
  expect(await tool("proposal_apply", { proposalId })).toMatchObject({ ok: true, output: { items: [{ outcome: "made" }] } });
});

test("a Job's installed tools, its runner tools' files and its cloud session's tools are refused per call, never as a bad token", async () => {
  const s = await setup();
  const server = await startFakeMcp([{ name: "get_mail", annotations: { readOnlyHint: true }, call: () => ({ content: [{ type: "text", text: "Your mail." }] }) }]);
  onTestFinished(() => server.close());
  const mail = await call(router.tools.create, { name: "Mail", url: server.url, transport: "streamable-http", headers: {} }, { context: s.a });
  const { job } = await jobIn(s.a, { toolIds: [mail.id] });
  const [run] = await s.owner.db.select().from(runs).where(eq(runs.id, job.runId));
  const token = jobTokenOf(s.owner.secrets, run!)!;
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("https://dispand.test/mcp/job/tools"), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (input, init) => handleJobToolsMcp(new Request(input as string | URL, init as RequestInit), s.a),
  }));
  onTestFinished(() => client.close());
  const name = (await client.listTools()).tools[0]!.name;
  const sessionId = "sess_refused";
  await s.owner.db.update(stepRuns).set({ sessionId }).where(and(eq(stepRuns.runId, job.runId), eq(stepRuns.nodeId, JOB_STEP)));
  const installed = { call: vi.fn(async () => ({ ok: true, result: { text: "ran", isError: false } })) };
  const caller = installedToolCaller(s.owner.db, installed as unknown as InstalledTools);
  const upload = () => handleJobFiles(new Request("https://dispand.test/mcp/job/files", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ files: [{ name: "a.txt", base64: "eA==" }] }),
  }), s.a);
  const allow = s.refuse();
  expect(await client.callTool({ name, arguments: {} })).toMatchObject({ isError: true, content: [{ type: "text", text: REFUSED }] });
  const refusedUpload = await upload();
  expect([refusedUpload.status, await refusedUpload.json()]).toEqual([403, { error: REFUSED }]);
  expect(await caller.call(sessionId, `tool:${mail.id}:get_mail`, {}, new AbortController().signal)).toEqual({ text: REFUSED, isError: true });
  expect(installed.call).not.toHaveBeenCalled();
  // Allowed again: the same calls go through.
  allow();
  expect(await client.callTool({ name, arguments: {} })).toMatchObject({ content: [{ type: "text", text: "Your mail." }] });
  expect((await upload()).status).toBe(200);
  expect(await caller.call(sessionId, `tool:${mail.id}:get_mail`, {}, new AbortController().signal)).toEqual({ text: "ran", isError: false });
});

test("an OAuth callback into a refused organization answers 403 with its sentence and leaves the flow as it was", async () => {
  const s = await setup();
  const state = "a-flow-of-a-refused-organization";
  await s.owner.db.insert(toolsTable).values({ id: "tool_oauth", workspaceId: s.a.workspaceId, ownerId: s.owner.ownerId, name: "Mail", kind: "http", url: "https://example.com/mcp", transport: "streamable-http", auth: "oauth", oauthStateHash: stateHash(state) } as never);
  s.refuse();
  const res = await handleToolOAuthCallback(new Request(`https://dispand.test/oauth/callback?state=${state}&code=c`, { headers: { cookie: s.a.headers.get("cookie")! } }), s.owner);
  expect([res.status, await res.text()]).toEqual([403, REFUSED]);
  expect((await s.owner.db.select({ hash: toolsTable.oauthStateHash }).from(toolsTable).where(eq(toolsTable.id, "tool_oauth")))[0]!.hash).toBe(stateHash(state));
});

test("what reaches into no organization still answers for a refused organization's people", async () => {
  const s = await setup();
  s.refuse();
  expect(await call(router.auth.me, undefined, { context: s.a })).toMatchObject({ ownerId: s.owner.ownerId });
  expect((await call(router.workspace.mine, undefined, { context: s.a })).map((w) => w.workspaceId)).toEqual([s.a.workspaceId, "ws_b"]);
  expect(await call(router.workspace.managed, undefined, { context: s.a })).toHaveLength(2);
  expect(await call(router.profile.get, undefined, { context: s.a })).toEqual({ description: null });
  expect(await call(router.profile.update, { description: "I answer about invoices." }, { context: s.a })).toEqual({ description: "I answer about invoices." });
  await call(router.push.unsubscribe, { endpoint: "https://push.example.com/phone" }, { context: s.a });
  // The profile's Audit rows go to the workspaces of the organizations still allowed only.
  const written = await s.owner.db.select({ workspaceId: audit.workspaceId }).from(audit).where(eq(audit.action, "profile.updated"));
  expect(written).toEqual([{ workspaceId: "ws_b" }]);
});

test("every procedure called into a refused organization answers its refusal, but those that reach into none", async () => {
  const s = await setup();
  const { runId } = await jobIdentity(s.a);
  const [step] = await s.owner.db.select({ id: stepRuns.id }).from(stepRuns).where(eq(stepRuns.runId, runId));
  await s.owner.db.insert(messages).values({ id: "msg_refused", runId, stepRunId: step!.id, role: "assistant", text: "Here." });
  await s.owner.db.insert(artifacts).values({ id: "art_refused", runId, stepRunId: step!.id, messageId: "msg_refused", title: "Chart", format: "svg", code: "<svg/>" });
  const scope = { organizationId: s.a.organizationId, workspaceId: s.a.workspaceId };
  // One for a new account (Grace), one addressed to the owner who calls.
  const { token } = await call(router.workspace.invite, { ...scope, email: "grace@example.com", role: "member" }, { context: s.a });
  const { token: own } = await call(router.workspace.invite, { ...scope, email: "ada@example.com", role: "member" }, { context: s.a });
  s.refuse();
  // The procedures that find their organization from their input (a row, a scope, a token): an input placed in A.
  const inputs: Record<string, unknown> = {
    "jobs.def": { runId }, "jobs.get": { id: runId }, "runs.access": { runId }, "runs.get": { runId }, "artifacts.get": { id: "art_refused" },
    "workspace.people": scope, "workspace.invitations": scope, "workspace.invite": { ...scope, email: "grace@example.com", role: "member" },
    "workspace.removePerson": { ...scope, userId: "user_nobody" }, "workspace.revokeInvitation": { ...scope, id: "inv_nobody" },
    "workspace.invitation": { token: own }, "workspace.acceptInvitation": { token: own }, "workspace.registrationPreview": { token, email: "grace@example.com" },
    "workspace.registerInvitation": { token, email: "grace@example.com", name: "Grace", password: "a long password" },
  };
  const answered: string[] = [];
  for (const { path, procedure } of procedures(router)) {
    const error = await Promise.resolve(call(procedure as never, inputs[path] as never, { context: s.a, path: path.split(".") })).then(() => undefined, (e: unknown) => e);
    const refused = error instanceof ORPCError && error.code === "FORBIDDEN" && (error.data as { organizationId?: string } | undefined)?.organizationId === s.a.organizationId;
    if (!refused) answered.push(path);
  }
  // Into no organization (first-run setup, the person, their workspaces to choose from, their profile, signing out a device),
  // and `runs.stream`, which admits on each read.
  expect(answered).toEqual(["auth.setup", "auth.status", "auth.me", "runs.stream", "push.unsubscribe", "workspace.mine", "workspace.managed", "profile.get", "profile.update"]);
  // Nothing was written into A meanwhile: the invitations are still there to accept once allowed, and no account was made from one.
  expect(await s.owner.db.select({ id: workspaceInvitations.id }).from(workspaceInvitations).where(eq(workspaceInvitations.workspaceId, s.a.workspaceId))).toHaveLength(2);
  expect(await s.owner.db.select({ id: user.id }).from(user).where(eq(user.email, "grace@example.com"))).toEqual([]);
  // An invitation that isn't the caller's, or for another address, still says nothing of the organization.
  await expect(call(router.workspace.invitation, { token }, { context: s.a })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.workspace.registrationPreview, { token, email: "eve@example.com" }, { context: s.a })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

/** Every procedure of the router, by its path. */
function procedures(at: Record<string, unknown>, path: string[] = []): { path: string; procedure: unknown }[] {
  return Object.entries(at).flatMap(([key, value]) => {
    if ((value as { "~orpc"?: unknown })["~orpc"]) return [{ path: [...path, key].join("."), procedure: value }];
    return value && typeof value === "object" ? procedures(value as Record<string, unknown>, [...path, key]) : [];
  });
}
