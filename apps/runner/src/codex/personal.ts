// Codex on a personal subscription, the supervisor's side: what the model relay attaches to a
// personal worker's requests. The worker holds no credential (`config.ts`, `subscriptionRelay`):
// the access token and account header are read here, from the supervisor's own login store, at
// each use, and kept in memory only. Renewal goes through the supervisor's one serialized renewal
// (`Subscriptions.renew`): refresh tokens rotate, so no other copy of the login may ever renew it.
import { tmpdir } from "node:os";
import { identityDigest, subscriptionEnv, type Subscriptions } from "../subscriptions/supervisor.ts";
import { CodexRpc } from "./rpc.ts";

/** The headers the relay sets on a model request it forwards to the provider: never logged, never sent to a worker. */
export type CodexCredential = { authorization: string; "chatgpt-account-id": string };

export type CodexSubscriptionOptions = {
  /** The supervisor's subscriptions: their renewal is the only one. */
  subscriptions: Subscriptions;
  /** The runner's config folder, which holds the login store. */
  configDir: string;
  /** The machine's `codex`, read at use. */
  codexPath: () => string | undefined;
  env: NodeJS.ProcessEnv;
  /** The identity digest the enrollment bound: a login as anyone else serves nothing. */
  identity: string;
  /** Called once each time the login stops serving (renewal denied, or another identity signed in), until it serves again. */
  onSignInNeeded: () => void;
  timeoutMs?: number;
};

export class CodexSubscription {
  private readonly o: CodexSubscriptionOptions;
  /** Set once the login stopped serving, so the sign-in is asked for once; cleared when it serves again. */
  private told = false;
  /**
   * Every read and renewal of this store, one at a time: Codex may renew a token near its expiry
   * on a read too, and a refresh token used twice ends the login.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: CodexSubscriptionOptions) {
    this.o = options;
  }

  /**
   * The credential for the next request, or undefined when the login can't serve the enrolled
   * identity. Checked at each read, as Claude Code's: once renewal gave up, nothing until the login
   * file changes (a fresh sign-in), with no restart.
   */
  read(): Promise<CodexCredential | undefined> {
    return this.serial(async () => ((await this.o.subscriptions.givenUp("codex")) ? this.deny() : this.fetch()));
  }

  /**
   * After the provider refused `rejected` (a 401): renews in the supervisor, then reads the
   * renewed credential. A renewal that doesn't serve counts toward the supervisor's attempts; once
   * it gives up, the login serves nothing and asks for a sign-in once, however often the CLI
   * resends its request.
   */
  renew(rejected: CodexCredential): Promise<CodexCredential | undefined> {
    return this.serial(async () => {
      if (await this.o.subscriptions.givenUp("codex")) return this.deny();
      // Another request's renewal already replaced it: one refresh for every request it failed. A
      // login that no longer serves the enrolled identity isn't this source's to renew.
      const now = await this.fetch();
      if (now?.authorization !== rejected.authorization) return now;
      let renewed: CodexCredential | undefined;
      // Codex reports the account even when its refresh failed: the same token is no renewal.
      const served = async () => {
        renewed = await this.fetch();
        return !!renewed && renewed.authorization !== rejected.authorization;
      };
      if (await this.o.subscriptions.renew(served)) return renewed;
      return (await this.o.subscriptions.givenUp("codex")) ? this.deny() : undefined;
    });
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run);
    this.queue = next.catch(() => {});
    return next;
  }

  private deny(): undefined {
    if (!this.told) this.o.onSignInNeeded();
    this.told = true;
    return undefined;
  }

  // shortcut: one app-server per read, a few hundred ms per model request; keep one open per grant if that shows.
  private async fetch(): Promise<CodexCredential | undefined> {
    const path = this.o.codexPath();
    if (!path) return undefined;
    const timeoutMs = this.o.timeoutMs ?? 15_000;
    let rpc: CodexRpc | undefined;
    try {
      rpc = await CodexRpc.spawn(path, subscriptionEnv(this.o.configDir, "codex", this.o.env), tmpdir(), AbortSignal.timeout(timeoutMs));
      const auth = await rpc.request("getAuthStatus", { includeToken: true, refreshToken: false });
      const { activeSessionId, sessions } = await rpc.request("accountSession/list", {});
      const active = sessions.find((s) => s.sessionId === activeSessionId);
      if (auth.authMethod !== "chatgpt" || !auth.authToken || !active?.userId || !active.selectedWorkspaceAccountId) return this.deny();
      // The user and the account both: a renewal or a sign-in that changed either serves nothing.
      if (identityDigest(active.userId, active.selectedWorkspaceAccountId) !== this.o.identity) return this.deny();
      this.told = false;
      return { authorization: `Bearer ${auth.authToken}`, "chatgpt-account-id": active.selectedWorkspaceAccountId };
    } catch {
      // The reason stays here: an app-server's error may quote what it read.
      return undefined;
    } finally {
      await rpc?.close();
    }
  }
}
