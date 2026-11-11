import { randomBytes } from "node:crypto";
import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { ToolError } from "./errors.ts";
import { countOAuth } from "./oauth-store.ts";

/**
 * What Dispand keeps of a tool's OAuth sign-in, sealed whole (`tools/oauth.ts`). Client
 * information and tokens are kept per authorization server (its `issuer`), as the SDK hands them.
 */
export type OAuthState = {
  issuers: Record<string, { client?: StoredOAuthClientInformation; tokens?: StoredOAuthTokens }>;
  /** The issuer of the tokens saved last: the transport's per-request read names none. */
  current?: string;
  discovery?: OAuthDiscoveryState;
  /**
   * The client the owner entered, for a server that supports neither metadata documents nor
   * registration; bound to the issuer it was first used with, and never sent to another.
   */
  entered?: { client_id: string; client_secret?: string; issuer?: string };
  /** The flow under way: its `state`, PKCE verifier and the discovery made for it, until it expires. */
  pending?: { state: string; verifier?: string; discovery?: OAuthDiscoveryState; expiresAt: number };
};

/** Reads and changes a tool's sealed state; `change` runs on the row locked, so two connections never lose a write. */
export type OAuthStore = {
  /** The tool's id: refreshes of one tool run one at a time. */
  key: string;
  read(): Promise<OAuthState>;
  change(edit: (state: OAuthState) => void): Promise<void>;
  /** The tool's grant stopped working: its owner signs in again (`oauth_status = reauthorize`). */
  reauthorize(): Promise<void>;
};

/**
 * `authorize`: Connect or Re-authorize from the tool's page (fresh discovery, no tokens, the flow
 * recorded for the callback). `finish`: the callback, with the flow it consumed. `use`: a listing
 * or a call, which may refresh the tokens but never starts a flow.
 */
export type OAuthMode = { kind: "authorize" } | { kind: "finish"; pending: NonNullable<OAuthState["pending"]> } | { kind: "use" };

/** A listing or call needs its owner to sign in again; the tool is marked so before this is thrown. */
export class ReauthorizeError extends ToolError {
  override name = "ReauthorizeError";
}

/**
 * The refresh under way per tool, in this process. A refresh token is used once (rotation), and a
 * server that sees one used twice may revoke the whole grant: two connections whose token expired
 * together refresh one after the other, the second with the token the first saved.
 */
const refreshes = new Map<string, Promise<void>>();

/** Waits for the tool's refresh under way, if any, and holds the tool's turn; the function returned gives it back. */
async function turn(key: string): Promise<() => void> {
  const before = refreshes.get(key);
  let done!: () => void;
  const mine = new Promise<void>((resolve) => (done = resolve));
  const queued = (before ?? Promise.resolve()).then(() => mine);
  refreshes.set(key, queued);
  await before;
  return () => {
    done();
    if (refreshes.get(key) === queued) refreshes.delete(key);
  };
}

/** Refreshes under way or waiting, all tools together (tests). */
export const refreshTurns = () => refreshes.size;

/** How long a started flow stays valid. */
export const FLOW_TTL_MS = 10 * 60_000;

export const CALLBACK_PATH = "/oauth/callback";
export const CLIENT_DOCUMENT_PATH = "/oauth/metadata";

/** Dispand's client id where an authorization server takes a metadata document's URL. */
export const clientDocumentUrl = (appUrl: string) => new URL(CLIENT_DOCUMENT_PATH, appUrl).href;

/** The client Dispand presents to an authorization server: what its metadata document says, and what it registers. */
export function clientMetadata(appUrl: string): OAuthClientMetadata & { redirect_uris: [string] } {
  return {
    client_name: "Dispand",
    redirect_uris: [new URL(CALLBACK_PATH, appUrl).href],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/** The issuer of the tokens saved last, or the one an SDK call names. */
const issuerOf = (state: OAuthState, ctx?: OAuthClientInformationContext) => ctx?.issuer ?? state.current;

/** Every secret of the state, which the server may send back: tokens and client secrets. */
export function stateSecrets(state: OAuthState): string[] {
  const found = [state.entered?.client_secret];
  for (const { client, tokens } of Object.values(state.issuers)) found.push(client?.client_secret, tokens?.access_token, tokens?.refresh_token);
  return found.filter((s): s is string => typeof s === "string" && s.length > 0);
}

/**
 * The SDK's `OAuthClientProvider` over a tool's sealed state. The SDK runs discovery, the client
 * metadata document or registration, PKCE, the resource indicator, the issuer checks and the
 * refresh; this only keeps what it hands over. `secrets` collects every token and client secret
 * it read or saved, so what the server sends back is redacted of them.
 */
export function createOAuthProvider(store: OAuthStore, mode: OAuthMode, appUrl: string, secrets: Set<string>) {
  const metadata = clientMetadata(appUrl);
  // The SDK refuses a metadata document's URL that isn't https: it registers instead (development).
  const documentUrl = new URL(appUrl).protocol === "https:" ? clientDocumentUrl(appUrl) : undefined;
  const keep = (tokens: StoredOAuthTokens | undefined) => {
    if (tokens?.access_token) secrets.add(tokens.access_token);
    if (tokens?.refresh_token) secrets.add(tokens.refresh_token);
    return tokens;
  };
  /** The refresh token this connection read, so it only discards tokens no other connection replaced since. */
  let used: string | undefined;
  /** Authorize only: the flow, recorded once the SDK hands the authorization URL. */
  const flow: { state?: string; verifier?: string; discovery?: OAuthDiscoveryState; url?: URL } = {};
  let discovered = false;
  let client = false;
  /** Use only: this connection's turn to refresh, held from the SDK's token read until it saves or gives up. */
  let held: (() => void) | undefined;
  const release = () => {
    held?.();
    held = undefined;
  };
  /**
   * Set once the connection ended. A turn is only ever held by a connection still open, which
   * gives it back as it ends: one that comes after the end is given back at once, and that SDK
   * attempt stops there.
   */
  let closed = false;

  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return metadata.redirect_uris[0];
    },
    ...(documentUrl ? { clientMetadataUrl: documentUrl } : {}),
    get clientMetadata() {
      return metadata;
    },
    state() {
      flow.state = randomBytes(32).toString("base64url");
      return flow.state;
    },
    async clientInformation(ctx) {
      const state = await store.read();
      const issuer = issuerOf(state, ctx);
      const { entered } = state;
      if (entered) {
        client = true;
        // Entered for one authorization server: its secret never goes to another the server names later.
        if (entered.issuer && issuer && entered.issuer !== issuer) {
          throw new ToolError("The server now names another authorization server than the one its client id was entered for: enter the client id that server gave you");
        }
        if (entered.client_secret) secrets.add(entered.client_secret);
        return entered;
      }
      const info = state.issuers[issuer ?? ""]?.client;
      if (info) client = true;
      if (info?.client_secret) secrets.add(info.client_secret);
      return info;
    },
    async saveClientInformation(info, ctx) {
      client = true;
      if (info.client_secret) secrets.add(info.client_secret);
      await store.change((state) => {
        const issuer = issuerOf(state, ctx);
        if (!issuer) return;
        // The entered client stays the owner's: it is bound to the issuer it is first used with.
        if (state.entered?.client_id === info.client_id) {
          state.entered.issuer ??= issuer;
          return;
        }
        state.issuers[issuer] = { ...state.issuers[issuer], client: info };
      });
    },
    async tokens(ctx) {
      // Connect and Re-authorize start over: no stored token is sent or refreshed.
      if (mode.kind === "authorize") return undefined;
      // With `ctx`, the SDK is about to refresh: after any refresh under way, with what it saved.
      if (ctx && mode.kind === "use" && !held) {
        const mine = await turn(store.key);
        if (closed) {
          mine();
          throw new ToolError("The call ended before its sign-in could be renewed");
        }
        held = mine;
      }
      const state = await store.read();
      const tokens = keep(state.issuers[issuerOf(state, ctx) ?? ""]?.tokens);
      used = tokens?.refresh_token;
      return tokens;
    },
    async saveTokens(tokens, ctx) {
      keep(tokens);
      if (mode.kind === "use") countOAuth("refresh", "ok");
      used = tokens.refresh_token;
      await store.change((state) => {
        const issuer = issuerOf(state, ctx) ?? tokens.issuer;
        if (!issuer) return;
        state.issuers[issuer] = { ...state.issuers[issuer], tokens };
        state.current = issuer;
        if (mode.kind === "finish" && mode.pending.discovery) state.discovery = mode.pending.discovery;
      });
      release();
    },
    async redirectToAuthorization(url) {
      release();
      if (mode.kind === "authorize") {
        flow.url = url;
        return;
      }
      if (mode.kind === "use") {
        // The SDK got here because no token works: refresh refused (its tokens discarded), or none to refresh with.
        const state = await store.read();
        const tokens = state.issuers[state.current ?? ""]?.tokens;
        if (!tokens?.refresh_token) {
          countOAuth("refresh", "reauthorize");
          await store.reauthorize();
          throw new ReauthorizeError("The sign-in to this tool stopped working: re-authorize it on its page in Settings → Tools");
        }
      }
      if (mode.kind === "use") countOAuth("refresh", "failed");
      throw new ToolError("The tool's sign-in couldn't be renewed: try again later");
    },
    saveCodeVerifier(verifier) {
      if (mode.kind === "authorize") flow.verifier = verifier;
    },
    codeVerifier() {
      if (mode.kind !== "finish" || !mode.pending.verifier) throw new ToolError("No sign-in is under way for this tool");
      return mode.pending.verifier;
    },
    async saveDiscoveryState(discovery) {
      discovered = true;
      if (mode.kind === "authorize") flow.discovery = discovery;
      else if (mode.kind === "use") {
        await store.change((state) => {
          state.discovery = discovery;
        });
      }
    },
    async discoveryState() {
      if (mode.kind === "authorize") return undefined;
      if (mode.kind === "finish") return mode.pending.discovery;
      return (await store.read()).discovery;
    },
    async invalidateCredentials(scope) {
      if (mode.kind === "finish" && scope === "verifier") return;
      await store.change((state) => {
        const issuer = state.current ?? "";
        if (scope === "all" || scope === "tokens") {
          // Another connection may have refreshed meanwhile (rotation): its tokens stay.
          const stored = state.issuers[issuer]?.tokens;
          if (stored && (mode.kind !== "use" || stored.refresh_token === used)) delete state.issuers[issuer]!.tokens;
        }
        if (scope === "all" || scope === "client") for (const entry of Object.values(state.issuers)) delete entry.client;
        if (scope === "all" || scope === "discovery") delete state.discovery;
      });
    },
  };

  return {
    provider,
    /** Authorize only: the authorization URL and the flow to record, once the SDK handed it. */
    started: () => (flow.url && flow.state ? { url: flow.url, pending: { state: flow.state, verifier: flow.verifier, discovery: flow.discovery, expiresAt: Date.now() + FLOW_TTL_MS } } : undefined),
    /** Discovery succeeded but no client could be had: the server supports neither metadata documents nor registration. */
    needsClient: () => discovered && !client,
    /** The connection ended: its refresh turn is given back, now or as soon as it comes. */
    release: () => {
      closed = true;
      release();
    },
  };
}
