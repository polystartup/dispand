// Claude Code on a personal subscription, the supervisor's side: what the model relay attaches to a
// personal worker's requests. The worker holds only its grant's token as a placeholder bearer
// (`claude.ts`, `personalClaudeEnv`): the subscription's `claude setup-token` token is read here,
// from the supervisor's own store, at each use, and kept in memory only. It is long-lived and has
// no renewal: once the provider refuses it, it serves nothing until the person signs in again.
import { claudeIdentity, readClaudeLogin, type Subscriptions } from "./subscriptions/supervisor.ts";

/** The header the relay sets on a model request it forwards to the provider: never logged, never sent to a worker. */
export type ClaudeCredential = { authorization: string };

export type ClaudeSubscriptionOptions = {
  /** The supervisor's subscriptions: they record a refused token, which their status reports. */
  subscriptions: Subscriptions;
  /** The runner's config folder, which holds the token. */
  configDir: string;
  /** The identity digest the enrollment bound: another sign-in serves nothing. */
  identity: string;
  /** Called once each time the token stops serving (refused, or another sign-in), until it serves again. */
  onSignInNeeded: () => void;
};

export class ClaudeSubscription {
  private readonly o: ClaudeSubscriptionOptions;
  private denied = false;

  constructor(options: ClaudeSubscriptionOptions) {
    this.o = options;
  }

  /** The credential for the next request, or undefined when the sign-in there isn't the enrolled one or was refused. */
  async read(): Promise<ClaudeCredential | undefined> {
    const login = readClaudeLogin(this.o.configDir);
    if (!login || claudeIdentity(login) !== this.o.identity || (await this.o.subscriptions.givenUp("claude-code"))) return this.deny();
    this.denied = false;
    return { authorization: `Bearer ${login.token}` };
  }

  /**
   * After the provider refused `rejected` (a 401): there is no renewal, so the sign-in is marked as
   * needed once, however often the CLI resends its request. A refusal of a token already replaced
   * by a new sign-in changes nothing.
   */
  async renew(rejected: ClaudeCredential): Promise<undefined> {
    const login = readClaudeLogin(this.o.configDir);
    if (!login || `Bearer ${login.token}` !== rejected.authorization) return undefined;
    await this.o.subscriptions.refused("claude-code");
    return this.deny();
  }

  private deny(): undefined {
    if (!this.denied) this.o.onSignInNeeded();
    this.denied = true;
    return undefined;
  }
}
