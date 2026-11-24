import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { WebPushError } from "web-push";
import { expect, onTestFinished, test, vi } from "vitest";
import { organizationMembers, pushSubscriptions, questions, stepRuns, user, workspaceMembers, workspaces } from "../db/schema.ts";
import { inScope, SYSTEM } from "../db/scope.ts";
import { rendered } from "../messages/index.ts";
import { router } from "../rpc/router.ts";
import { runnerWithClis, asCli, ownerContext, recordScopes } from "../runners/test-support.ts";
import { subscriptionKeysAad } from "./keys.ts";
import { PushSender, pushTargets, type PushPayload, type Send } from "./sender.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

const SECRET = "Ship the order to the customer at 12 Example Street?";

/** The owner signed in, an agent "Drafting" with a Job, and a fake push service that records what reaches each endpoint. */
async function setup() {
  const context = await ownerContext();
  const { runnerId } = await runnerWithClis(context);
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const agent = await call(router.agents.create, { name: "Drafting", harnessId: harness.id, systemPrompt: "" }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
  const [step] = await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
  let n = 0;
  /** A new pending item of the Job: an Approval, or a Question with choices. */
  const ask = async (kind: "approval" | "question" = "question") => {
    // PGlite's clock ticks in milliseconds: an item asked in the subscription's millisecond would tie with it.
    await tick();
    const id = `q_push_${++n}`;
    await context.db.insert(questions).values({
      id,
      ownerId: context.ownerId, addresseeId: context.ownerId,
      runId,
      stepRunId: step!.id,
      sessionId: step!.sessionId!,
      runnerQuestionId: `rq_${n}`,
      placement: "notifications",
      kind,
      payload:
        kind === "approval"
          ? { kind: "permission", toolName: "Bash", input: { command: SECRET }, canAlwaysAllow: false }
          : { kind: "choice", questions: [{ question: SECRET, header: "Ship", multiSelect: false, options: [{ label: "Yes", description: SECRET }] }] },
      status: "pending",
    });
    return id;
  };
  const sent: { endpoint: string; payload: PushPayload }[] = [];
  const failing = new Map<string, number>();
  const send = vi.fn<Send>(async (subscription, payload) => {
    const status = failing.get(subscription.endpoint);
    if (status) {
      failing.delete(subscription.endpoint);
      throw new WebPushError("refused", status, {}, "", subscription.endpoint);
    }
    sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) as PushPayload });
  });
  const subscribe = async (device: string, language: "en" | "fr" = "en") => {
    await tick();
    await call(router.push.subscribe, { endpoint: `https://push.example.com/${device}`, keys: { p256dh: "p256dh-key", auth: "auth-key" }, language }, { context });
  };
  const sender = (windowMs = 10_000) => {
    const s = new PushSender(context.db, context.engine, context.secrets, { subject: "mailto:push@example.com", send, windowMs, retryMs: 60_000 });
    onTestFinished(() => s.stop());
    return s;
  };
  return { context, ask, sent, send, failing, subscribe, sender, endpoint: (device: string) => `https://push.example.com/${device}` };
}

test("a new approval sends one payload of exactly the sentence, the count and the item's id, no question text", async () => {
  const { ask, sent, subscribe, sender, endpoint } = await setup();
  await subscribe("phone");
  const id = await ask("approval");
  await sender().flush();
  expect(sent).toEqual([{ endpoint: endpoint("phone"), payload: { text: rendered("en", "push.approval", { agent: "Drafting", count: 1 }), count: 1, itemId: id } }]);
  expect(Object.keys(sent[0]!.payload).sort()).toEqual(["count", "itemId", "text"]);
  expect(sent[0]!.payload.text).toBe("Drafting needs your decision.");
  expect(JSON.stringify(sent)).not.toContain("Ship");
});

test("a pending approval stops generating pushes after the subscriber loses access", async () => {
  const { context, subscribe, sender, send, ask } = await setup();
  await subscribe("phone");
  await ask("approval");
  await context.db.delete(organizationMembers).where(eq(organizationMembers.userId, context.ownerId));
  await sender().flush();
  expect(send).not.toHaveBeenCalled();
});

test("an item pending at start is pushed once after a restart", async () => {
  const { context, ask, sent, subscribe, sender } = await setup();
  await subscribe("phone");
  const id = await ask();
  // The app stops inside the batching window: nothing went yet.
  const before = sender();
  before.start();
  context.engine.questionChanges.publish("changed", true);
  await before.stop();
  expect(sent).toEqual([]);
  const after = sender(10);
  after.start();
  await vi.waitFor(() => expect(sent.map((s) => s.payload.itemId)).toEqual([id]));
  await after.flush();
  expect(sent).toHaveLength(1);
});

test("with two devices where the second fails once, the retry reaches only the second", async () => {
  const { ask, sent, failing, subscribe, sender, endpoint } = await setup();
  await subscribe("laptop");
  await subscribe("phone");
  await ask();
  failing.set(endpoint("phone"), 500);
  const s = sender();
  await s.flush();
  expect(sent.map((x) => x.endpoint)).toEqual([endpoint("laptop")]);
  await s.flush();
  expect(sent.map((x) => x.endpoint)).toEqual([endpoint("laptop"), endpoint("phone")]);
});

test("a French browser with no Settings choice gets French pushes", async () => {
  const { ask, sent, subscribe, sender } = await setup();
  await subscribe("phone", "fr");
  await ask();
  await sender().flush();
  expect(sent[0]!.payload.text).toBe(rendered("fr", "push.question", { agent: "Drafting", count: 1 }));
  expect(sent[0]!.payload.text).toBe("Drafting a une question pour vous.");
});

test("switching Settings to English after opting in makes the next push English", async () => {
  const { context, ask, sent, subscribe, sender } = await setup();
  await subscribe("phone", "fr");
  await context.db.update(user).set({ language: "en" }).where(eq(user.id, context.ownerId));
  await ask("approval");
  await sender().flush();
  expect(sent[0]!.payload.text).toBe("Drafting needs your decision.");
});

test("a device that opts in while items wait gets no push for them", async () => {
  const { ask, sent, subscribe, sender } = await setup();
  await ask();
  await subscribe("phone");
  const s = sender();
  await s.flush();
  expect(sent).toEqual([]);
  const later = await ask();
  await s.flush();
  expect(sent.map((x) => x.payload)).toEqual([expect.objectContaining({ itemId: later, count: 1 })]);
});

test("after signing out, that browser's subscription is gone and it gets no push", async () => {
  const { context, ask, sent, subscribe, sender, endpoint } = await setup();
  await subscribe("phone");
  await subscribe("laptop");
  await call(router.push.unsubscribe, { endpoint: endpoint("phone") }, { context });
  expect((await call(router.push.list, undefined, { context })).devices).toHaveLength(1);
  await ask();
  await sender().flush();
  expect(sent.map((x) => x.endpoint)).toEqual([endpoint("laptop")]);
});

test("three items within the window send one push with count 3, naming the newest", async () => {
  const { context, ask, sent, subscribe, sender } = await setup();
  await subscribe("phone");
  const s = sender(200);
  s.start();
  await ask();
  context.engine.questionChanges.publish("changed", true);
  await ask();
  context.engine.questionChanges.publish("changed", true);
  const newest = await ask("approval");
  context.engine.questionChanges.publish("changed", true);
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]!.payload).toEqual({ text: rendered("en", "push.approval", { agent: "Drafting", count: 3 }), count: 3, itemId: newest });
  expect(sent[0]!.payload.text).toBe("Drafting needs your decision, and 3 items wait in all.");
  await s.flush();
  expect(sent).toHaveLength(1);
});

test("a 410 deletes that subscription and the others still get theirs", async () => {
  const { context, ask, sent, failing, subscribe, sender, endpoint } = await setup();
  await subscribe("old");
  await subscribe("phone");
  failing.set(endpoint("old"), 410);
  await ask();
  const s = sender();
  await s.flush();
  expect(sent.map((x) => x.endpoint)).toEqual([endpoint("phone")]);
  expect((await context.db.select({ endpoint: pushSubscriptions.endpoint }).from(pushSubscriptions)).map((r) => r.endpoint)).toEqual([endpoint("phone")]);
  await ask();
  await s.flush();
  expect(sent.map((x) => x.endpoint)).toEqual([endpoint("phone"), endpoint("phone")]);
});

test("no subscription, no error and nothing sent", async () => {
  const { ask, send, sender } = await setup();
  await ask();
  await expect(sender().flush()).resolves.toBeUndefined();
  expect(send).not.toHaveBeenCalled();
});

test("telemetry counts each push by outcome, without its text", async () => {
  const { captureTelemetry } = await import("../telemetry/testing.ts");
  const telemetry = await captureTelemetry();
  onTestFinished(() => telemetry.stop());
  const { ask, failing, subscribe, sender, endpoint } = await setup();
  await subscribe("phone");
  await subscribe("old");
  failing.set(endpoint("old"), 404);
  await ask();
  await sender().flush();
  const pushes = (await telemetry.metrics()).filter((m) => m.name === "dispand.push.sent").map((m) => m.attributes["dispand.result"]);
  expect(pushes.sort()).toEqual(["gone", "sent"]);
  expect(await telemetry.all()).not.toContain("Drafting");
});

test("a push is posted encrypted through the given fetch, and a refusal carries the push service's status", async () => {
  const { createECDH, randomBytes } = await import("node:crypto");
  const { generateVAPIDKeys } = await import("web-push");
  const { pushVia } = await import("./sender.ts");
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const subscription = { endpoint: "https://push.example.com/phone", keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
  const options = { vapidDetails: { subject: "mailto:push@example.com", ...generateVAPIDKeys() } };
  const posted: [string, RequestInit][] = [];
  let status = 201;
  const send = pushVia((async (url: string, init: RequestInit) => {
    posted.push([url, init]);
    return new Response(null, { status });
  }) as typeof fetch);
  await send(subscription, JSON.stringify({ text: SECRET, count: 1, itemId: "q_1" }), options);
  const [url, init] = posted[0]!;
  expect([url, init.method, init.redirect]).toEqual(["https://push.example.com/phone", "POST", "manual"]);
  expect(Object.fromEntries(init.headers as [string, string][])).toMatchObject({ "Content-Encoding": "aes128gcm", TTL: "2419200" });
  expect(Buffer.from(init.body as Uint8Array).toString()).not.toContain("Ship");
  status = 410;
  await expect(send(subscription, "{}", options)).rejects.toMatchObject({ name: "WebPushError", statusCode: 410 });
});

test("a device that keeps failing is tried twice as late each time, up to an hour", async () => {
  const { retryDelay } = await import("./sender.ts");
  expect([1, 2, 3, 4].map((n) => retryDelay(n))).toEqual([60_000, 120_000, 240_000, 480_000]);
  expect(retryDelay(20)).toBe(3_600_000);
});

/** A member of the workspace (not an owner), with a device, and a question asked to them. */
async function member(s: Awaited<ReturnType<typeof setup>>) {
  const { context } = s;
  const userId = "user_member";
  await context.db.insert(user).values({ id: userId, name: "Bo", email: "bo@example.com" });
  await context.db.insert(organizationMembers).values({ organizationId: context.organizationId, userId, role: "member" });
  await context.db.insert(workspaceMembers).values({ workspaceId: context.workspaceId, userId, role: "member" });
  await tick();
  const endpoint = s.endpoint("member-phone");
  await context.db.insert(pushSubscriptions).values({ id: "push_member", ownerId: userId, endpoint, keys: context.secrets.seal(JSON.stringify({ p256dh: "k", auth: "a" }), subscriptionKeysAad(endpoint)), label: "Phone", language: "en" });
  const ask = async () => {
    const id = await s.ask();
    await context.db.update(questions).set({ ownerId: userId, addresseeId: userId }).where(eq(questions.id, id));
    return id;
  };
  return { userId, endpoint, ask };
}

test("pushTargets lists each workspace's recipients with an item waiting, never an idle workspace", async () => {
  const s = await setup();
  await s.context.db.insert(workspaces).values({ id: "ws_b", organizationId: s.context.organizationId });
  const m = await member(s);
  expect(await pushTargets(s.context.db)).toEqual([]);
  await m.ask();
  expect(await pushTargets(s.context.db)).toEqual([{ organizationId: s.context.organizationId, workspaceId: s.context.workspaceId, userId: m.userId }]);
});

test("a member gets pushes; once removed from the workspace, no push and no retry", async () => {
  const s = await setup();
  const m = await member(s);
  const sender = s.sender();
  await m.ask();
  await sender.flush();
  expect(s.sent.map((p) => p.endpoint)).toEqual([m.endpoint]);
  await s.context.db.delete(workspaceMembers).where(eq(workspaceMembers.userId, m.userId));
  await m.ask();
  await sender.flush();
  expect(s.send).toHaveBeenCalledTimes(1);
  expect((sender as unknown as { timer?: unknown }).timer).toBeUndefined();
});

test("a flush woken inside a workspace's scope runs under SYSTEM", async () => {
  const s = await setup();
  await s.subscribe("phone");
  await s.ask();
  const recorder = await recordScopes(s.context.db);
  const sender = new PushSender(recorder.db, s.context.engine, s.context.secrets, { subject: "mailto:push@example.com", send: s.send, windowMs: 1 });
  onTestFinished(() => sender.stop());
  await inScope({ workspaceId: "ws_elsewhere" }, () => sender.wake(1));
  await vi.waitFor(() => expect(s.send).toHaveBeenCalledTimes(1));
  await sender.stop();
  expect(new Set(recorder.statements.map((st) => st.scope))).toEqual(new Set([SYSTEM]));
});

test("on an install with a second workspace, signing out still deletes that browser's subscription, and it gets no push", async () => {
  const { context, ask, subscribe, sender, send, endpoint } = await setup();
  await subscribe("phone");
  await context.db.insert(workspaces).values({ id: "ws_b", organizationId: context.organizationId });
  await call(router.push.unsubscribe, { endpoint: endpoint("phone") }, { context });
  await ask();
  await sender().flush();
  expect(send).not.toHaveBeenCalled();
});
