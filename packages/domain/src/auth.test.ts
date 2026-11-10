import { call, ORPCError } from "@orpc/server";
import { expect, test, vi } from "vitest";
import { createAuth } from "./auth.ts";
import { user } from "./db/schema.ts";
import { router } from "./rpc/router.ts";
import { emptyContext, testDb } from "./runners/test-support.ts";

const CODE = "test-setup-code-0123456789";
const owner = { name: "Ada", email: "ada@example.com", password: "correct horse battery", setupCode: CODE };

test("setup creates the owner when none exists", async () => {
  const context = await emptyContext();
  const out = await call(router.auth.setup, owner, { context });
  expect(out.ownerId).toBeTruthy();
  const res = await context.auth.api.signInEmail({ body: { email: owner.email, password: owner.password } });
  expect(res.user.id).toBe(out.ownerId);
});

test("setup is refused once an owner exists", async () => {
  const context = await emptyContext();
  await call(router.auth.setup, owner, { context });
  await expect(call(router.auth.setup, { ...owner, email: "b@example.com" }, { context })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});

test("concurrent setup calls create exactly one owner", async () => {
  const context = await emptyContext();
  const results = await Promise.allSettled([
    call(router.auth.setup, owner, { context }),
    call(router.auth.setup, { ...owner, email: "b@example.com" }, { context }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const failed = results.find((r) => r.status === "rejected");
  expect(failed).toMatchObject({ reason: { code: "FORBIDDEN" } });
  expect((await context.db.select().from(user)).length).toBe(1);
});

test("sign-up through Better Auth stays disabled", async () => {
  const context = await emptyContext();
  await expect(
    context.auth.api.signUpEmail({ body: { email: "x@example.com", password: "whatever-long", name: "X" } }),
  ).rejects.toBeInstanceOf(Error);
});

test("authed procedures reject without session", async () => {
  const context = await emptyContext();
  const err = await call(router.auth.me, undefined, { context }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ORPCError);
  expect(err).toMatchObject({ code: "UNAUTHORIZED" });
});

test("authed procedures accept the owner's session", async () => {
  const context = await emptyContext();
  await call(router.auth.setup, owner, { context });
  const res = await context.auth.api.signInEmail({
    body: { email: owner.email, password: owner.password },
    returnHeaders: true,
  });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const out = await call(router.auth.me, undefined, {
    context: { ...context, headers: new Headers({ cookie }) },
  });
  expect(out.ownerId).toBe(res.response.user.id);
});

test("a refused setup does not hash the password", async () => {
  const context = await emptyContext();
  await call(router.auth.setup, owner, { context });
  const ctx = await context.auth.$context;
  const hash = vi.spyOn(ctx.password, "hash");
  await expect(call(router.auth.setup, { ...owner, email: "b@example.com" }, { context })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  expect(hash).not.toHaveBeenCalled();
});

test("setup rejects passwords Better Auth would refuse at sign-in", async () => {
  const context = await emptyContext();
  await expect(
    call(router.auth.setup, { ...owner, password: "x".repeat(129) }, { context }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    call(router.auth.setup, { ...owner, password: "x".repeat(128) }, { context }),
  ).resolves.toBeTruthy();
});

test("authed forwards the session cookie Better Auth refreshes", async () => {
  const context = await emptyContext();
  const refreshed = new Headers({ "set-cookie": "better-auth.session_token=fresh; Path=/" });
  const auth = {
    api: { getSession: async () => ({ headers: refreshed, response: { user: { id: "user_1" } } }) },
  } as unknown as typeof context.auth;
  const out = await call(router.auth.me, undefined, { context: { ...context, auth } });
  expect(out.ownerId).toBe("user_1");
  expect(context.resHeaders.getSetCookie()).toEqual(["better-auth.session_token=fresh; Path=/"]);
});

test("production config throttles wrong sign-ins per client IP", async () => {
  const db = await testDb();
  const auth = createAuth(db, {
    baseURL: "https://app.example",
    secret: "test-secret-test-secret-test-secret",
    rateLimit: true,
  });
  // The reverse proxy in front of the app sets X-Real-IP; X-Forwarded-For (which a client can prefill) is ignored.
  const attempt = (ip: string, forwardedFor = `198.51.100.${Math.floor(Math.random() * 250)}`) =>
    auth.handler(
      new Request("https://app.example/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://app.example", "x-real-ip": ip, "x-forwarded-for": forwardedFor },
        body: JSON.stringify({ email: "ada@example.com", password: "wrong password" }),
      }),
    );
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) statuses.push((await attempt("203.0.113.7")).status);
  expect(statuses.slice(0, 3)).not.toContain(429);
  expect(statuses[3]).toBe(429);
  expect((await attempt("203.0.113.8")).status).not.toBe(429); // other clients are not throttled
});

test("a wrong setup code is refused before anything happens: no user, no hash", async () => {
  const context = await emptyContext();
  const ctx = await context.auth.$context;
  const hash = vi.spyOn(ctx.password, "hash");
  await expect(call(router.auth.setup, { ...owner, setupCode: "wrong-code-wrong-code" }, { context })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  expect(hash).not.toHaveBeenCalled();
  expect(await context.db.select().from(user)).toHaveLength(0);
  // the right code still works afterwards
  await expect(call(router.auth.setup, owner, { context })).resolves.toBeTruthy();
});
