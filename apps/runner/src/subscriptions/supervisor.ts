// Personal CLI subscriptions on the supervisor: each CLI's login in a home only the supervisor
// reads, what Dispand learns of it (who is signed in, as a digest), its renewal and its enrollment.
// No token, refresh token, sign-in link or provider code passes through this module: the login
// itself is the CLI's own (`dispand-runner sign-in`), and the requests below return none.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerToServer, type ServerToRunner, type SubscriptionStatus } from "@dispand/runner-protocol";
import { CodexRpc } from "../codex/rpc.ts";
import { writeDurable } from "../durable.ts";

export type Harness = SubscriptionStatus["harness"];
type Enroll = Extract<RunnerToServer, { type: "subscription.enroll" }>;
type Enrolled = Extract<ServerToRunner, { type: "subscription.enrolled" }>;

/** The supervisor's login homes, in the runner's config folder: no worker mounts it and no session may touch it. */
export function subscriptionsDir(configDir: string): string {
  return join(configDir, "subscriptions");
}

/**
 * `env` for a harness's CLI on the supervisor's own login store, apart from the CLI's default home
 * (which the runner's other sessions use) and without the provider keys a shell may hold.
 */
export function subscriptionEnv(configDir: string, harness: Harness, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const rest = { ...env };
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) delete rest[key];
  const home = join(subscriptionsDir(configDir), harness);
  return harness === "codex" ? { ...rest, CODEX_HOME: home } : { ...rest, CLAUDE_CONFIG_DIR: home };
}

/** The login files of the supervisor's subscriptions: a poll's result never carries their values. */
export function subscriptionLogins(configDir: string): string[] {
  return [join(subscriptionsDir(configDir), "codex", "auth.json"), join(subscriptionsDir(configDir), "claude-code", ".credentials.json")];
}

/** Kept in the Codex login home: the login is a file there, never the OS keyring the machine's own Codex may share. */
export const CODEX_STORE_CONFIG = 'cli_auth_credentials_store = "file"\n';

/** What Dispand compares: the provider's user and account, together, as one digest. */
export function identityDigest(userId: string, accountId: string): SubscriptionStatus["identity"] {
  return `sha256:${createHash("sha256").update(JSON.stringify([userId, accountId])).digest("hex")}`;
}

/** The ChatGPT user and account Codex is signed in as, as a digest; undefined when it isn't signed in to ChatGPT. */
async function codexIdentity(codexPath: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string | undefined> {
  const rpc = await CodexRpc.spawn(codexPath, env, tmpdir(), AbortSignal.timeout(timeoutMs));
  try {
    const { account } = await rpc.request("account/read", { refreshToken: false });
    if (account?.type !== "chatgpt") return undefined;
    const { activeSessionId, sessions } = await rpc.request("accountSession/list", {});
    const active = sessions.find((s) => s.sessionId === activeSessionId);
    return active?.userId && active.selectedWorkspaceAccountId ? identityDigest(active.userId, active.selectedWorkspaceAccountId) : undefined;
  } finally {
    await rpc.close();
  }
}

/** Codex's managed renewal in its own store: the reply says who is signed in, never with a token. */
async function codexRenew(codexPath: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
  const rpc = await CodexRpc.spawn(codexPath, env, tmpdir(), AbortSignal.timeout(timeoutMs));
  try {
    const { account } = await rpc.request("account/read", { refreshToken: true });
    if (account?.type !== "chatgpt") throw new Error("not signed in to ChatGPT");
  } finally {
    await rpc.close();
  }
}

/**
 * The enrollment Dispand bound for a harness on this runner, with the identity it bound: a grant
 * names it, and the relay serves only that identity's login. One per harness; a new one replaces it.
 */
export type Enrollment = { enrollmentId: string; identity: SubscriptionStatus["identity"] };
const enrollmentPath = (configDir: string, harness: Harness) => join(subscriptionsDir(configDir), `${harness}.enrollment.json`);

export function readEnrollment(configDir: string, harness: Harness): Enrollment | undefined {
  try {
    const raw = JSON.parse(readFileSync(enrollmentPath(configDir, harness), "utf8")) as Partial<Enrollment>;
    return typeof raw.enrollmentId === "string" && typeof raw.identity === "string" && /^sha256:[0-9a-f]{64}$/.test(raw.identity)
      ? { enrollmentId: raw.enrollmentId, identity: raw.identity as Enrollment["identity"] } : undefined;
  } catch {
    return undefined;
  }
}

/** Failed renewals in a row before the login is reported as needing a fresh sign-in, and renewal stops asking the provider. */
export const RENEWAL_ATTEMPTS = 3;

export type SubscriptionsOptions = {
  /** The runner's config folder: the logins live in its `subscriptions` folder. */
  configDir: string;
  /** The machine's `codex`, read at use. */
  codexPath: () => string | undefined;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

/**
 * The supervisor's subscriptions. Only Codex reports a status: Claude Code exposes its account's
 * email and organization, not a user id, without reading its token, so it signs in but isn't enrolled yet.
 */
export class Subscriptions {
  private readonly options: SubscriptionsOptions;
  private renewing: Promise<boolean> | undefined;
  private failures = 0;
  /** The login file's stamp when renewal gave up: a fresh sign-in changes it, and renewal starts over. */
  private gaveUp: string | undefined;
  private readonly asks = new Map<string, (reply: Enrolled) => void>();

  constructor(options: SubscriptionsOptions) {
    this.options = options;
  }

  private get codex() {
    const path = this.options.codexPath();
    return path ? { path, env: subscriptionEnv(this.options.configDir, "codex", this.options.env), timeoutMs: this.options.timeoutMs ?? 15_000 } : undefined;
  }

  private async stamp(): Promise<string> {
    const s = await stat(join(subscriptionsDir(this.options.configDir), "codex", "auth.json")).catch(() => undefined);
    return s ? `${s.mtimeMs}:${s.size}` : "none";
  }

  /** Whether renewal gave up on the login there is now; a new login clears it. */
  private async givenUp(): Promise<boolean> {
    if (this.gaveUp === undefined) return false;
    if (this.gaveUp === (await this.stamp())) return true;
    this.gaveUp = undefined;
    this.failures = 0;
    return false;
  }

  /** The statuses for `hello` and `clis.replied`, read from the CLI now: nothing is kept from an earlier report. */
  async status(): Promise<SubscriptionStatus[]> {
    const codex = this.codex;
    if (!codex || (await this.stamp()) === "none") return [];
    // A hard deadline too: an app-server that ignores its stop must not hold up the runner's hello.
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), codex.timeoutMs + 1000)));
    const identity = await Promise.race([codexIdentity(codex.path, codex.env, codex.timeoutMs).catch(() => undefined), late]).finally(() => clearTimeout(timer));
    return identity ? [{ harness: "codex", identity, signInNeeded: await this.givenUp() }] : [];
  }

  /**
   * Renews the Codex login in the supervisor: one provider call however many ask at once. After
   * `RENEWAL_ATTEMPTS` failures in a row, none at all until the person signs in again, and the
   * status says so: one sign-in request, never a retry loop.
   */
  renew(): Promise<boolean> {
    this.renewing ??= this.renewOnce().finally(() => {
      this.renewing = undefined;
    });
    return this.renewing;
  }

  private async renewOnce(): Promise<boolean> {
    const codex = this.codex;
    if (!codex || (await this.givenUp())) return false;
    const stamp = await this.stamp();
    try {
      await codexRenew(codex.path, codex.env, codex.timeoutMs);
      this.failures = 0;
      return true;
    } catch {
      if (++this.failures >= RENEWAL_ATTEMPTS) {
        this.gaveUp = stamp;
        console.error("dispand-runner: the Codex subscription can't renew: sign in again with `dispand-runner sign-in codex`");
      }
      return false;
    }
  }

  /**
   * Confirms Dispand's enrollment `challenge` with the identity signed in now, through `send` (the
   * runner's connection), and answers with what the person reads. The challenge is never kept.
   */
  async enroll(harness: string, challenge: string, send: (msg: Enroll) => boolean, timeoutMs = 30_000): Promise<{ ok: boolean; message: string }> {
    if (harness !== "codex") return { ok: false, message: "only Codex subscriptions can be enrolled on this runner for now" };
    const [status] = await this.status();
    if (!status) return { ok: false, message: "Codex isn't signed in to a ChatGPT subscription here: run `dispand-runner sign-in codex` first" };
    if (status.signInNeeded) return { ok: false, message: "this Codex sign-in can no longer renew: run `dispand-runner sign-in codex` again first" };
    const askId = randomUUID();
    const parsed = RunnerToServer.safeParse({ type: "subscription.enroll", askId, harness, identity: status.identity, challenge });
    if (!parsed.success) return { ok: false, message: "that isn't an enrollment challenge from Dispand" };
    return new Promise((resolve) => {
      const done = (answer: { ok: boolean; message: string }) => {
        clearTimeout(timer);
        this.asks.delete(askId);
        resolve(answer);
      };
      const timer = setTimeout(() => done({ ok: false, message: "Dispand didn't answer: try again" }), timeoutMs);
      // Printed in the person's terminal: no control character from the server reaches it.
      const plain = (s: string) => s.replace(/\p{Cc}/gu, "");
      this.asks.set(askId, (reply) => {
        if (reply.enrollmentId) {
          try {
            mkdirSync(subscriptionsDir(this.options.configDir), { recursive: true, mode: 0o700 });
            writeDurable(enrollmentPath(this.options.configDir, "codex"), JSON.stringify({ enrollmentId: reply.enrollmentId, identity: status.identity } satisfies Enrollment));
          } catch {
            return done({ ok: false, message: "Dispand bound the enrollment, but this runner couldn't record it: enroll again" });
          }
        }
        done(reply.enrollmentId
        ? { ok: true, message: `Enrolled: Dispand bound this Codex subscription (enrollment ${plain(reply.enrollmentId)}).` }
        : { ok: false, message: `Dispand bound nothing: ${plain(reply.error ?? "no reason given")}` });
      });
      if (!send(parsed.data as Enroll)) done({ ok: false, message: "the runner isn't connected to Dispand: try again once it is" });
    });
  }

  /** Dispand's answer to an enrollment this supervisor sent; any other is ignored. */
  enrolled(reply: Enrolled): void {
    this.asks.get(reply.askId)?.(reply);
  }
}
