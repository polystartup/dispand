import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { harnesses, pushKeys, pushSubscriptions, runs, tools } from "./db/schema.ts";
import { inScope, setTenancy, shared, type Tenancy } from "./db/scope.ts";
import { apiKeyAad, loadCloudHarness } from "./harnesses/cloud.ts";
import { jobTokenOf, tokenAad } from "./platform/token.ts";
import { subscriptionKeysAad, vapidAad, vapidKeys } from "./push/keys.ts";
import { jobIdentity, ownerContext } from "./runners/test-support.ts";
import { createSecretBox, SecretError, type SecretBox } from "./secrets.ts";
import { resealSecrets } from "./secrets-reseal.ts";
import { oauthAad, openState } from "./tools/oauth-store.ts";
import { headerAad, toolTarget, urlAad } from "./tools/store.ts";

const URL = "https://tools.example/mcp";
const ENDPOINT = "https://push.example.com/phone";
/** The format before key ids: the same sealed bytes, with no key id. */
const v1 = (sealed: string) => sealed.replace(/^v2\.[0-9a-f]{8}\./, "v1.");

/** One stored secret of every kind, sealed by `box` (`as` rewrites each, to `v1` say), and what reads each back. */
async function everyKind(as: (sealed: string) => string = (sealed) => sealed) {
  const context = await ownerContext();
  const before = randomBytes(32);
  const box = createSecretBox(before);
  const seal = (plain: string, aad: string) => as(box.seal(plain, aad));
  const { db, ownerId, workspaceId } = context;
  const { runId } = await jobIdentity(context);
  await db
    .update(runs)
    .set({ tokenSealed: seal("dj_token", tokenAad(runId)) })
    .where(eq(runs.id, runId));
  await db.insert(harnesses).values({
    id: "harness_cloud",
    workspaceId,
    ownerId,
    name: "Cloud",
    type: "cloud",
    kind: "anthropic",
    model: "m",
    apiKeySealed: seal("sk-key", apiKeyAad("harness_cloud")),
  });
  await db.insert(tools).values([
    {
      id: "tool_headers",
      workspaceId,
      ownerId,
      name: "Headers",
      kind: "http",
      url: URL,
      transport: "streamable-http",
      auth: "headers",
      headersSealed: {
        authorization: seal("Bearer a", headerAad("tool_headers", "authorization", URL)),
        "x-team": seal("team", headerAad("tool_headers", "x-team", URL)),
      },
      urlSealed: seal(JSON.stringify({ url: `${URL}?key=k`, secrets: ["k"] }), urlAad("tool_headers")),
    },
    {
      id: "tool_oauth",
      workspaceId,
      ownerId,
      name: "OAuth",
      kind: "http",
      url: URL,
      transport: "streamable-http",
      auth: "oauth",
      oauthSealed: seal(JSON.stringify({ issuers: {}, current: "https://issuer.example" }), oauthAad("tool_oauth")),
    },
  ]);
  await db.insert(pushKeys).values({ id: "vapid", publicKey: "public", privateKey: seal("private", vapidAad) });
  await db.insert(pushSubscriptions).values({
    id: "sub_phone",
    ownerId,
    endpoint: ENDPOINT,
    keys: seal(JSON.stringify({ p256dh: "p", auth: "a" }), subscriptionKeysAad(ENDPOINT)),
    label: "Phone",
    language: "en",
  });

  /** Every value, opened through what reads it in use. */
  const read = async (secrets: SecretBox) => {
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    const [headers] = await db.select().from(tools).where(eq(tools.id, "tool_headers"));
    const [oauth] = await db.select().from(tools).where(eq(tools.id, "tool_oauth"));
    const [sub] = await db.select().from(pushSubscriptions);
    const target = toolTarget(headers!, secrets);
    return {
      apiKey: (await loadCloudHarness(db, secrets, workspaceId, "harness_cloud")).apiKey,
      token: jobTokenOf(secrets, run!),
      headers: target.headers,
      url: target.url,
      oauth: openState(secrets, "tool_oauth", oauth!.oauthSealed).current,
      vapid: (await vapidKeys(db, secrets)).privateKey,
      subscription: JSON.parse(secrets.open(sub!.keys, subscriptionKeysAad(ENDPOINT))) as unknown,
    };
  };
  const plain = {
    apiKey: "sk-key",
    token: "dj_token",
    headers: { authorization: "Bearer a", "x-team": "team" },
    url: `${URL}?key=k`,
    oauth: "https://issuer.example",
    vapid: "private",
    subscription: { p256dh: "p", auth: "a" },
  };
  /** Every stored sealed text, to see what a pass rewrote. */
  const stored = async () => ({
    token: (await db.select({ v: runs.tokenSealed }).from(runs).where(eq(runs.id, runId)))[0]!.v,
    apiKey: (await db.select({ v: harnesses.apiKeySealed }).from(harnesses).where(eq(harnesses.id, "harness_cloud")))[0]!.v,
    headers: (await db.select({ v: tools.headersSealed }).from(tools).where(eq(tools.id, "tool_headers")))[0]!.v,
    url: (await db.select({ v: tools.urlSealed }).from(tools).where(eq(tools.id, "tool_headers")))[0]!.v,
    oauth: (await db.select({ v: tools.oauthSealed }).from(tools).where(eq(tools.id, "tool_oauth")))[0]!.v,
    vapid: (await db.select({ v: pushKeys.privateKey }).from(pushKeys))[0]!.v,
    subscription: (await db.select({ v: pushSubscriptions.keys }).from(pushSubscriptions))[0]!.v,
  });
  return { context, before, read, plain, stored };
}

/** The eight values `everyKind` stores (two headers). */
const VALUES = 8;
const sealedValues = (s: Awaited<ReturnType<Awaited<ReturnType<typeof everyKind>>["stored"]>>) => [
  s.token,
  s.apiKey,
  ...Object.values(s.headers),
  s.url,
  s.oauth,
  s.vapid,
  s.subscription,
];

test("with no previous key the pass reads nothing and changes nothing", async () => {
  const { context, before, stored } = await everyKind();
  const was = await stored();
  expect(await resealSecrets(context.db, createSecretBox(before))).toEqual({ resealed: 0, unopened: 0, failed: 0 });
  expect(await stored()).toEqual(was);
});

test("after a rotation, every kind of secret the release before key ids sealed is sealed again under the new key and reads with it alone; the next start changes nothing", async () => {
  const { context, before, read, plain, stored } = await everyKind(v1);
  expect(sealedValues(await stored()).every((s) => s!.startsWith("v1."))).toBe(true);
  const after = randomBytes(32);
  const ring = createSecretBox(after, before);
  // While both keys are set, everything opens, before the pass as after it.
  expect(await read(ring)).toEqual(plain);
  expect(await resealSecrets(context.db, ring)).toEqual({ resealed: VALUES, unopened: 0, failed: 0 });
  expect(sealedValues(await stored()).every((s) => s!.startsWith(ring.current))).toBe(true);
  // The previous key dropped: every value reads with the new key alone, and none with the old one.
  expect(await read(createSecretBox(after))).toEqual(plain);
  await expect(read(createSecretBox(before))).rejects.toBeInstanceOf(SecretError);
  const done = await stored();
  expect(await resealSecrets(context.db, ring)).toEqual({ resealed: 0, unopened: 0, failed: 0 });
  expect(await stored()).toEqual(done);
});

test("a pass that stops halfway, under a tenancy that swallows a workspace's failure, says so; the next start finishes it and leaves what the first one moved", async () => {
  const { context, before, read, plain, stored } = await everyKind();
  // As a hosted install splits work: per listed scope, one scope's failure logged and swallowed.
  const swallowing: Tenancy = {
    async each(db, scopes, work) {
      for (const scope of await scopes(db)) await inScope(scope, work).catch(() => undefined);
    },
    forRun: (_db, _runId, work) => work(),
  };
  setTenancy(context.db, swallowing);
  onTestFinished(() => setTenancy(context.db, shared));
  const after = randomBytes(32);
  const ring = createSecretBox(after, before);
  // The process stops after three values: every reseal past them fails.
  let left = 3;
  const stopping: SecretBox = {
    ...ring,
    reseal: (sealed, aad) => {
      if (left-- <= 0) throw new Error("stopped");
      return ring.reseal(sealed, aad);
    },
  };
  const first = await resealSecrets(context.db, stopping);
  expect(first.resealed).toBe(3);
  expect(first.failed).toBeGreaterThan(0);
  const halfway = sealedValues(await stored());
  const moved = halfway.filter((s) => s!.startsWith(ring.current));
  expect(moved).toHaveLength(3);
  // The next start moves the rest, and only the rest.
  expect(await resealSecrets(context.db, ring)).toEqual({ resealed: VALUES - 3, unopened: 0, failed: 0 });
  const done = sealedValues(await stored());
  expect(done.every((s) => s!.startsWith(ring.current))).toBe(true);
  for (const value of moved) expect(done).toContain(value);
  expect(await read(createSecretBox(after))).toEqual(plain);
});

test("two processes starting at once rewrite each value once, and everything reads with the new key", async () => {
  const { context, before, read, plain, stored } = await everyKind();
  const after = randomBytes(32);
  const [a, b] = await Promise.all([resealSecrets(context.db, createSecretBox(after, before)), resealSecrets(context.db, createSecretBox(after, before))]);
  expect(a.resealed + b.resealed).toBe(VALUES);
  expect(a.unopened + b.unopened + a.failed + b.failed).toBe(0);
  expect(sealedValues(await stored()).every((s) => s!.startsWith(createSecretBox(after).current))).toBe(true);
  expect(await read(createSecretBox(after))).toEqual(plain);
});

test("a wrong previous key opens nothing and destroys nothing: every value is counted and left as it was, and moves once the right key is given", async () => {
  const { context, before, read, plain, stored } = await everyKind();
  const after = randomBytes(32);
  const wrong = createSecretBox(after, randomBytes(32));
  const was = await stored();
  expect(await resealSecrets(context.db, wrong)).toEqual({ resealed: 0, unopened: VALUES, failed: 0 });
  expect(await stored()).toEqual(was);
  await expect(read(wrong)).rejects.toBeInstanceOf(SecretError);
  const right = createSecretBox(after, before);
  expect(await resealSecrets(context.db, right)).toEqual({ resealed: VALUES, unopened: 0, failed: 0 });
  expect(await read(createSecretBox(after))).toEqual(plain);
});
