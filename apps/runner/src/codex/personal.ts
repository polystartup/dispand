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
  /** Set when the login stopped serving; cleared by a renewal that serves again. */
  private denied = false;
  /**
   * Every read and renewal of this store, one at a time: Codex may renew a token near its expiry
   * on a read too, and a refresh token used twice ends the login.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: CodexSubscriptionOptions) {
    this.o = options;
  }

  /** The credential for the next request, or undefined when the login can't serve the enrolled identity. */
  read(): Promise<CodexCredential | undefined> {
    return this.serial(() => (this.denied ? Promise.resolve(undefined) : this.fetch()));
  }

  /**
   * After the provider refused `rejected` (a 401): renews in the supervisor, then reads the
   * renewed credential. A denied renewal, or one that signed in as someone else, serves nothing
   * and asks for a sign-in once, however often the CLI resends its request.
   */
  renew(rejected: CodexCredential): Promise<CodexCredential | undefined> {
    return this.serial(async () => {
      // Another request's renewal already replaced it: one refresh for every request it failed.
      const now = this.denied ? undefined : await this.fetch(false);
      if (now && now.authorization !== rejected.authorization) return now;
      if (!(await this.o.subscriptions.renew())) return this.deny();
      const credential = await this.fetch();
      // Codex reports the account even when its refresh failed: the same token is no renewal.
      if (credential?.authorization === rejected.authorization) return this.deny();
      if (credential) this.denied = false;
      return credential;
    });
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run);
    this.queue = next.catch(() => {});
    return next;
  }

  private deny(): undefined {
    if (!this.denied) this.o.onSignInNeeded();
    this.denied = true;
    return undefined;
  }

  // shortcut: one app-server per read, a few hundred ms per model request; keep one open per grant if that shows.
  private async fetch(denies = true): Promise<CodexCredential | undefined> {
    const deny = () => (denies ? this.deny() : undefined);
    const path = this.o.codexPath();
    if (!path) return undefined;
    const timeoutMs = this.o.timeoutMs ?? 15_000;
    let rpc: CodexRpc | undefined;
    try {
      rpc = await CodexRpc.spawn(path, subscriptionEnv(this.o.configDir, "codex", this.o.env), tmpdir(), AbortSignal.timeout(timeoutMs));
      const auth = await rpc.request("getAuthStatus", { includeToken: true, refreshToken: false });
      const { activeSessionId, sessions } = await rpc.request("accountSession/list", {});
      const active = sessions.find((s) => s.sessionId === activeSessionId);
      if (auth.authMethod !== "chatgpt" || !auth.authToken || !active?.userId || !active.selectedWorkspaceAccountId) return deny();
      // The user and the account both: a renewal or a sign-in that changed either serves nothing.
      if (identityDigest(active.userId, active.selectedWorkspaceAccountId) !== this.o.identity) return deny();
      return { authorization: `Bearer ${auth.authToken}`, "chatgpt-account-id": active.selectedWorkspaceAccountId };
    } catch {
      // The reason stays here: an app-server's error may quote what it read.
      return undefined;
    } finally {
      await rpc?.close();
    }
  }
}
