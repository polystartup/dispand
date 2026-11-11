import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterEach, expect, test } from "vitest";
import { tools } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import { InstalledTools } from "./executor.ts";
import { createMcpConnector } from "./mcp.ts";
import { finishToolAuthorization, handleToolOAuthCallback } from "./oauth.ts";
import { openState } from "./oauth-store.ts";
import { startFakeAuthServer, startRecorder } from "./test-auth-server.ts";
import { startFakeMcp, type FakeAction } from "./test-server.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const APP = "https://dispand.test";

const echo: FakeAction = {
  name: "echo",
  description: "Says it back",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  call: (args) => ({ content: [{ type: "text", text: String(args.text) }] }),
};

/** A fake authorization server, and an MCP server it protects. */
async function servers(options: Parameters<typeof startFakeAuthServer>[0] = {}) {
  const as = await startFakeAuthServer(options);
  closers.push(as.close);
  const mcp = await startFakeMcp([echo], "streamable-http", { oauth: { authorizationServer: as.url, accepts: (t) => as.accepts(t) } });
  closers.push(mcp.close);
  return { as, mcp };
}

/** The owner's context, with a connector that knows the app's URL. */
async function context() {
  const ctx = await ownerContext();
  return { ...ctx, tools: createMcpConnector({ appUrl: APP }) };
}

type Ctx = Awaited<ReturnType<typeof context>>;

async function oauthTool(ctx: Ctx, url: string) {
  return call(router.tools.create, { name: "Mail", url, transport: "streamable-http", headers: {}, auth: "oauth" }, { context: ctx });
}

/** What the owner's browser does: follows the authorization URL to the server, which sends it back to the callback. */
async function signIn(url: string): Promise<URLSearchParams> {
  const res = await fetch(url, { redirect: "manual" });
  const back = new URL(res.headers.get("location")!);
  expect(back.origin + back.pathname).toBe(`${APP}/oauth/callback`);
  return back.searchParams;
}

const row = async (ctx: Ctx, id: string) => (await ctx.db.select().from(tools).where(eq(tools.id, id)))[0]!;

/** Connects the tool all the way: authorize, the browser, the callback. */
async function connect(ctx: Ctx, id: string, client?: { clientId: string; clientSecret?: string }) {
  const { url } = await call(router.tools.authorize, { id, ...(client ? { client } : {}) }, { context: ctx });
  const params = await signIn(url);
  expect(await finishToolAuthorization(ctx, ctx.ownerId, params)).toEqual({ toolId: id, ok: true });
}

const tokensOf = (ctx: Ctx, r: Awaited<ReturnType<typeof row>>) => {
  const state = openState(ctx.secrets, r.id, r.oauthSealed);
  return state.issuers[state.current!]!.tokens!;
};

test("the whole flow with a client metadata document: connected, actions listed, tokens sealed", async () => {
  const { as, mcp } = await servers({ metadataDocuments: true });
  const ctx = await context();
  const tool = await oauthTool(ctx, mcp.url);
  expect(tool).toMatchObject({ auth: "oauth", oauthStatus: "authorize", actions: [] });

  const { url } = await call(router.tools.authorize, { id: tool.id }, { context: ctx });
  const asked = new URL(url);
  expect(asked.origin).toBe(as.url);
  expect(asked.searchParams.get("client_id")).toBe(`${APP}/oauth/client`);
  expect(asked.searchParams.get("redirect_uri")).toBe(`${APP}/oauth/callback`);
  expect(asked.searchParams.get("code_challenge_method")).toBe("S256");
  expect(asked.searchParams.get("resource")).toBe(mcp.url);
  // The flow waits for the callback, sealed: neither its state nor its verifier in plain text.
  const waiting = await row(ctx, tool.id);
  expect(waiting.oauthStateHash).not.toBeNull();
  expect(JSON.stringify(waiting)).not.toContain(asked.searchParams.get("state"));

  const params = await signIn(url);
  expect(await finishToolAuthorization(ctx, ctx.ownerId, params)).toEqual({ toolId: tool.id, ok: true });
  const connected = await call(router.tools.get, { id: tool.id }, { context: ctx });
  expect(connected).toMatchObject({ oauthStatus: "connected", actionsError: null, actions: [{ name: "echo" }] });

  // Sealed in the database, and never in what the browser gets.
  const stored = await row(ctx, tool.id);
  const tokens = tokensOf(ctx, stored);
  expect(tokens.access_token).toMatch(/^at-/);
  expect(stored.oauthStateHash).toBeNull();
  for (const shown of [JSON.stringify(stored), JSON.stringify(connected), JSON.stringify(await call(router.tools.list, undefined, { context: ctx }))]) {
    expect(shown).not.toContain(tokens.access_token);
    expect(shown).not.toContain(tokens.refresh_token);
  }
  // The code was exchanged with the flow's verifier, as the client the document names.
  expect(as.tokenRequests[0]!.form).toMatchObject({ grant_type: "authorization_code", client_id: `${APP}/oauth/client`, resource: mcp.url });
  // A call carries the token to the MCP server.
  const installed = new InstalledTools(ctx.db, ctx.secrets, ctx.tools);
  expect(await installed.call(stored, "echo", { text: "hi" }, new AbortController().signal)).toEqual({ ok: true, result: { text: "hi", isError: false } });
  expect(mcp.requests.at(-1)!.authorization).toBe(`Bearer ${tokens.access_token}`);
});

test("an entered client id and secret, where the server supports neither metadata documents nor registration", async () => {
  const { as, mcp } = await servers({ client: { id: "given-id", secret: "given-s3cret" } });
  const ctx = await context();
  const tool = await oauthTool(ctx, mcp.url);
  await expect(call(router.tools.authorize, { id: tool.id }, { context: ctx })).rejects.toThrow(/supports neither client metadata documents nor registration/);

  await connect(ctx, tool.id, { clientId: "given-id", clientSecret: "given-s3cret" });
  const view = await call(router.tools.get, { id: tool.id }, { context: ctx });
  expect(view).toMatchObject({ oauthStatus: "connected", oauthClientId: "given-id", actions: [{ name: "echo" }] });
  expect(JSON.stringify(view)).not.toContain("given-s3cret");
  const stored = await row(ctx, tool.id);
  expect(JSON.stringify(stored)).not.toContain("given-s3cret");
  // The secret went to the token endpoint only.
  const exchange = as.tokenRequests.at(-1)!;
  expect(`${exchange.authorization ?? ""} ${exchange.form.client_secret ?? ""}`).toMatch(/Basic |given-s3cret/);
  expect(mcp.requests.some((h) => JSON.stringify(h).includes("given-s3cret"))).toBe(false);
});

test("dynamic registration, when the server offers it", async () => {
  const { as, mcp } = await servers({ registration: true });
  const ctx = await context();
  const tool = await oauthTool(ctx, mcp.url);
  await connect(ctx, tool.id);
  expect(as.paths).toContain("/register");
  expect(await call(router.tools.get, { id: tool.id }, { context: ctx })).toMatchObject({ oauthStatus: "connected" });
});

test("an expired access token is refreshed, and the new tokens sealed", async () => {
  const { as, mcp } = await servers({ metadataDocuments: true });
  const ctx = await context();
  const tool = await oauthTool(ctx, mcp.url);
  await connect(ctx, tool.id);
  const before = tokensOf(ctx, await row(ctx, tool.id));
  as.expireAccessTokens();

  const installed = new InstalledTools(ctx.db, ctx.secrets, ctx.tools);
  expect(await installed.call(await row(ctx, tool.id), "echo", { text: "again" }, new AbortController().signal)).toEqual({ ok: true, result: { text: "again", isError: false } });
  expect(as.tokenRequests.at(-1)!.form).toMatchObject({ grant_type: "refresh_token", refresh_token: before.refresh_token });
  const after = tokensOf(ctx, await row(ctx, tool.id));
  expect(after.access_token).not.toBe(before.access_token);
  expect(after.refresh_token).not.toBe(before.refresh_token);
  expect((await row(ctx, tool.id)).oauthStatus).toBe("connected");
});

test("a refresh refused marks the tool re-authorize, fails its calls with that reason, and is never tried again", async () => {
  const { as, mcp } = await servers({ metadataDocuments: true, refusesRefresh: true });
  const ctx = await context();
  const tool = await oauthTool(ctx, mcp.url);
  await connect(ctx, tool.id);
  as.expireAccessTokens();
  const installed = new InstalledTools(ctx.db, ctx.secrets, ctx.tools);
  const tokenCalls = as.tokenRequests.length;
  const signal = new AbortController().signal;

  for (let i = 0; i < 3; i++) {
    const called = await installed.call(await row(ctx, tool.id), "echo", { text: "hi" }, signal);
    expect(called).toEqual({ ok: false, error: expect.stringMatching(/re-authorize/) });
  }
  // One refresh, refused; then no request at all: no loop, and no new flow started from a call.
  expect(as.tokenRequests.slice(tokenCalls).map((r) => r.form.grant_type)).toEqual(["refresh_token"]);
  expect(as.authorizations).toHaveLength(1);
  const stored = await row(ctx, tool.id);
  expect(stored.oauthStatus).toBe("reauthorize");
  expect(stored.oauthStateHash).toBeNull();
  expect(openState(ctx.secrets, tool.id, stored.oauthSealed).pending).toBeUndefined();
  expect(await call(router.tools.get, { id: tool.id }, { context: ctx })).toMatchObject({ oauthStatus: "reauthorize" });
  // Listing fails the same way, without a request.
  const paths = as.paths.length;
  expect(await call(router.tools.refresh, { id: tool.id }, { context: ctx })).toMatchObject({ actionsError: expect.stringMatching(/re-authorize/) });
  expect(as.paths).toHaveLength(paths);

  // Re-authorize connects it again.
  await connect(ctx, tool.id);
  expect((await row(ctx, tool.id)).oauthStatus).toBe("connected");
});

test("a callback with a wrong state is refused, and the flow under way stays", async () => {
  const { mcp } = await servers({ metadataDocuments: true });
  const ctx = await context();
  const tool = await oauthTool(ctx, mcp.url);
  const { url } = await call(router.tools.authorize, { id: tool.id }, { context: ctx });
  const params = await signIn(url);
  const forged = new URLSearchParams(params);
  forged.set("state", "not-the-state");
  expect(await finishToolAuthorization(ctx, ctx.ownerId, forged)).toEqual({ ok: false });
  expect((await row(ctx, tool.id)).oauthStatus).toBe("authorize");

  // Another owner can't finish it, even with the right state.
  expect(await finishToolAuthorization(ctx, "user_someone_else", params)).toEqual({ ok: false });

  // Through the route: a session is needed, and a used state can't be used again.
  const request = (headers: Headers) => new Request(`${APP}/oauth/callback?${params.toString()}`, { headers });
  const app = { db: ctx.db, auth: ctx.auth, secrets: ctx.secrets, tools: ctx.tools };
  expect((await handleToolOAuthCallback(request(new Headers()), app)).status).toBe(401);
  const done = await handleToolOAuthCallback(request(ctx.headers), app);
  expect(done.status).toBe(303);
  expect(done.headers.get("location")).toBe(`/settings/tools?tool=${tool.id}`);
  expect(done.headers.get("referrer-policy")).toBe("no-referrer");
  expect((await row(ctx, tool.id)).oauthStatus).toBe("connected");
  expect((await handleToolOAuthCallback(request(ctx.headers), app)).status).toBe(400);
});

test("a redirect to another origin during discovery is refused, and nothing reaches it", async () => {
  const elsewhere = await startRecorder();
  closers.push(elsewhere.close);
  const { as, mcp } = await servers({ metadataDocuments: true, redirectMetadataTo: `${elsewhere.url}/.well-known/oauth-authorization-server` });
  const ctx = await context();
  const tool = await oauthTool(ctx, mcp.url);
  await expect(call(router.tools.authorize, { id: tool.id }, { context: ctx })).rejects.toThrow();
  // The authorization server answered with the redirect; it wasn't followed.
  expect(as.paths).toContain("/.well-known/oauth-authorization-server");
  expect(elsewhere.requests).toEqual([]);
  expect((await row(ctx, tool.id)).oauthStateHash).toBeNull();
});

test("a redirect to another origin during the token exchange is refused: no code, verifier or secret reaches it", async () => {
  const elsewhere = await startRecorder();
  closers.push(elsewhere.close);
  const { as, mcp } = await servers({ client: { id: "given-id", secret: "given-s3cret" }, redirectTokenTo: `${elsewhere.url}/token` });
  const ctx = await context();
  const tool = await oauthTool(ctx, mcp.url);
  const { url } = await call(router.tools.authorize, { id: tool.id, client: { clientId: "given-id", clientSecret: "given-s3cret" } }, { context: ctx });
  const params = await signIn(url);
  expect(await finishToolAuthorization(ctx, ctx.ownerId, params)).toEqual({ toolId: tool.id, ok: false });
  expect(as.tokenRequests).toHaveLength(1);
  expect(elsewhere.requests).toEqual([]);
  const stored = await row(ctx, tool.id);
  expect(stored.oauthStatus).toBe("authorize");
  expect(stored.actionsError).toBeTruthy();
  expect(stored.actionsError).not.toContain(params.get("code")!);
});

test("an OAuth tool takes no header, and leaving OAuth drops its sign-in", async () => {
  const { mcp } = await servers({ metadataDocuments: true });
  const ctx = await context();
  await expect(call(router.tools.create, { name: "Both", url: mcp.url, transport: "streamable-http", headers: { authorization: "Bearer x" }, auth: "oauth" }, { context: ctx })).rejects.toThrow(/no headers/);
  const plain = await call(router.tools.create, { name: "Plain", url: mcp.url, transport: "streamable-http", headers: { authorization: "Bearer x" } }, { context: ctx });
  expect(plain).toMatchObject({ auth: "headers", oauthStatus: null });
  // Switching to OAuth drops the headers: they would reach the authorization server too.
  const switched = await call(router.tools.update, { id: plain.id, auth: "oauth" }, { context: ctx });
  expect(switched).toMatchObject({ auth: "oauth", headerNames: [], oauthStatus: "authorize" });
  await connect(ctx, plain.id);
  const back = await call(router.tools.update, { id: plain.id, auth: "none" }, { context: ctx });
  expect(back).toMatchObject({ auth: "none", oauthStatus: null });
  const stored = await row(ctx, plain.id);
  expect(stored.oauthSealed).toBeNull();
});

test("the client metadata document names the app and its callback, and nothing secret", async () => {
  const { clientDocument } = await import("./oauth.ts");
  const res = clientDocument(APP);
  expect(await res.json()).toEqual({
    client_id: `${APP}/oauth/client`,
    client_name: "Dispand",
    redirect_uris: [`${APP}/oauth/callback`],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
});
