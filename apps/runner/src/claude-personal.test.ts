import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSessionStart } from "@dispand/runner-protocol";
import { afterEach, expect, test, vi } from "vitest";
import { ClaudeSubscription } from "./claude-personal.ts";
import { startClaudeSession } from "./claude.ts";
import { claudeIdentity, claudeLoginPath, readClaudeLogin, Subscriptions, writeClaudeLogin } from "./subscriptions/supervisor.ts";

const made: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const TOKEN = "sk-ant-oat01-SENTINEL-first";
const NEXT = "sk-ant-oat01-SENTINEL-second";
const RELAY = { url: "http://relay.example.test", grant: "grant-token" };

/** The supervisor's Claude Code sign-in, enrolled as such. */
async function supervisor() {
  const configDir = await mkdtemp(join(tmpdir(), "claude-personal-"));
  made.push(configDir);
  writeClaudeLogin(configDir, TOKEN);
  const subscriptions = new Subscriptions({ configDir, codexPath: () => undefined, env: {} });
  const onSignInNeeded = vi.fn();
  const credential = new ClaudeSubscription({ subscriptions, configDir, identity: claudeIdentity(readClaudeLogin(configDir)!), onSignInNeeded });
  vi.spyOn(console, "error").mockImplementation(() => {});
  return { configDir, subscriptions, credential, onSignInNeeded };
}

const start: ClaudeSessionStart = {
  sessionId: "ses_1", harness: "claude-code", cwd: { mode: "per-run", runKey: "run_1" }, systemPrompt: "", prompt: "Hi",
  expectedOutputs: [], interactive: false, permissionMode: "default", skills: [], mcpServers: [], grant: { id: "grt_1", enrollmentId: "enr_1", ttlMs: 60_000 },
};

/** The options the SDK gets for a session, on a query that ends at once. */
function launched(env: NodeJS.ProcessEnv) {
  const calls: Options[] = [];
  const q = (({ options }: { options: Options }) => {
    calls.push(options);
    return Object.assign((async function* () {})(), { supportedCommands: async () => [], setMcpServers: async () => ({ added: [], removed: [], errors: {} }), interrupt: async () => undefined });
  }) as unknown as typeof query;
  startClaudeSession(start, "/work", () => {}, { query: q, env, launch: () => { throw new Error("unused"); }, subscriptionRelay: RELAY, secrets: [] });
  return calls[0]!;
}

test("a personal worker's environment holds the relay and its grant's placeholder, never a credential", async () => {
  const { configDir } = await supervisor();
  const { env } = launched({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/c", ANTHROPIC_API_KEY: "sk-runner-own", ANTHROPIC_AUTH_TOKEN: "x", CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ANTHROPIC_BASE_URL: "https://api.anthropic.com" });
  expect(env).toMatchObject({ ANTHROPIC_BASE_URL: RELAY.url, CLAUDE_CODE_OAUTH_TOKEN: RELAY.grant, CLAUDE_CONFIG_DIR: "/c" });
  expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
  expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  expect(JSON.stringify(env)).not.toContain(TOKEN);
  expect(JSON.stringify(env)).not.toContain(configDir);
  // Without its worker or its relay, a personal session never starts.
  expect(() => startClaudeSession(start, "/tmp", () => {}, { secrets: [], subscriptionRelay: RELAY })).toThrow();
  expect(() => startClaudeSession(start, "/tmp", () => {}, { secrets: [], launch: () => { throw new Error("unused"); } })).toThrow();
});

test("the enrolled sign-in's token serves, and only the supervisor's store holds it (0600)", async () => {
  const { configDir, credential } = await supervisor();
  expect(await credential.read()).toEqual({ authorization: `Bearer ${TOKEN}` });
  const { stat } = await import("node:fs/promises");
  expect((await stat(claudeLoginPath(configDir))).mode & 0o777).toBe(0o600);
});

test("a token the provider refuses produces one sign-in request, serves nothing more, and a fresh sign-in serves again", async () => {
  const { configDir, subscriptions, credential, onSignInNeeded } = await supervisor();
  const refused = (await credential.read())!;
  for (let i = 0; i < 4; i++) expect(await credential.renew(refused)).toBeUndefined();
  expect(await credential.read()).toBeUndefined();
  expect(onSignInNeeded).toHaveBeenCalledTimes(1);
  expect(console.error).toHaveBeenCalledTimes(1);
  expect(await subscriptions.status()).toEqual([{ harness: "claude-code", identity: claudeIdentity(readClaudeLogin(configDir)!), signInNeeded: true }]);
  // The same sign-in's token rewritten as it was doesn't count as a new sign-in: only `sign-in` makes one.
  writeClaudeLogin(configDir, NEXT);
  expect((await subscriptions.status())[0]).toMatchObject({ signInNeeded: false });
  // A new sign-in is a new identity: the old enrollment's source serves it nothing.
  expect(await credential.read()).toBeUndefined();
  const next = new ClaudeSubscription({ subscriptions, configDir, identity: claudeIdentity(readClaudeLogin(configDir)!), onSignInNeeded: vi.fn() });
  expect(await next.read()).toEqual({ authorization: `Bearer ${NEXT}` });
});

test("a late refusal of a token a new sign-in already replaced changes nothing", async () => {
  const { configDir, subscriptions, credential } = await supervisor();
  const old = (await credential.read())!;
  const login = readClaudeLogin(configDir)!;
  // The same sign-in id with a new token: only a store a person rewrote by hand looks like this.
  await writeFile(claudeLoginPath(configDir), JSON.stringify({ ...login, token: NEXT }));
  await credential.renew(old);
  expect(await subscriptions.givenUp("claude-code")).toBe(false);
  expect(await credential.read()).toEqual({ authorization: `Bearer ${NEXT}` });
});

test("another sign-in than the enrolled one serves nothing, and asks for a sign-in once", async () => {
  const { configDir, credential, onSignInNeeded } = await supervisor();
  writeClaudeLogin(configDir, TOKEN);
  expect(await credential.read()).toBeUndefined();
  expect(await credential.read()).toBeUndefined();
  expect(onSignInNeeded).toHaveBeenCalledTimes(1);
});
