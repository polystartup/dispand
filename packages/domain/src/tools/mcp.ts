import {
  Client,
  OAuthError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Tool,
  type Transport,
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/client";
import { McpAction } from "@dispand/runner-protocol";
import { z } from "zod";
import { MAX_ACTIONS, redact, screenedFetch } from "./inbound.ts";
import { ToolError } from "./errors.ts";
import { BlockedAddressError } from "./network.ts";
import { createOAuthProvider, stateSecrets, type OAuthMode, type OAuthState, type OAuthStore } from "./oauth-provider.ts";

export { ToolError } from "./errors.ts";

export { inboundProblem, MAX_ACTIONS, MAX_MESSAGE_VALUES, MAX_RESPONSE_BYTES, redact } from "./inbound.ts";

export const TRANSPORTS = ["streamable-http", "sse"] as const;
export type ToolTransport = (typeof TRANSPORTS)[number];
/** How an HTTP tool signs in: nothing, its sealed headers, or OAuth. */
export const AUTHS = ["none", "headers", "oauth"] as const;
export type ToolAuth = (typeof AUTHS)[number];
export type OAuthStatus = "authorize" | "connected" | "reauthorize";

/** Where an HTTP tool is and how to call it. `headers` are opened from the secret box just for the call. */
export type ToolTarget = {
  url: string;
  transport: ToolTransport;
  headers: Record<string, string>;
  /** Secrets the URL's path or query holds (a plugin server's settings): redacted like the headers. */
  urlSecrets?: string[];
  /** An OAuth tool's sealed state (`tools/oauth.ts`); its headers are empty then. */
  oauth?: OAuthStore;
};

/**
 * One action of a tool. `outputSchema`, when the server gives one, names the fields of a
 * structured result. `readOnly` is the server's own claim (`readOnlyHint`): it decides nothing
 * by itself, and only fills an agent's unasked actions when a person adds the tool to it.
 */
export type ToolAction = McpAction & { outputSchema?: Record<string, unknown>; readOnly?: true };

/**
 * A file in a result's content (an image, an embedded resource's blob): its bytes as the server
 * sent them, never read here. Only a Job keeps them (`keepJobFiles`); anywhere else they are dropped.
 */
export type ToolFile = { name: string; bytes: Uint8Array };

/** `hasMore`: the server stopped at its own cap (`_meta.result_has_more`), with more to give. */
export type ToolResult = { text: string; structured?: Record<string, unknown>; isError: boolean; files?: ToolFile[]; hasMore?: boolean };

/** The one way Dispand calls MCP servers over HTTP: actions for Settings → Tools, calls for agents and Tool steps. */
export type ToolConnector = {
  listActions(target: ToolTarget): Promise<ToolAction[]>;
  callAction(target: ToolTarget, action: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
  /**
   * Starts an OAuth tool's sign-in: the SDK discovers its authorization server and gets a client
   * (metadata document, registration, or the entered one). Gives the URL to send the owner to and
   * the flow to keep for the callback, or null when the server asks for no sign-in.
   */
  authorize(target: ToolTarget & { oauth: OAuthStore }): Promise<{ url: URL; pending: NonNullable<OAuthState["pending"]> } | null>;
  /** Hands the callback's parameters to the SDK (`finishAuth`), which exchanges the code with the flow's verifier. */
  finishAuthorization(target: ToolTarget & { oauth: OAuthStore }, pending: NonNullable<OAuthState["pending"]>, params: URLSearchParams): Promise<void>;
};

/** Each schema, as JSON. */
export const MAX_SCHEMA_BYTES = 64 * 1024;
export const LIST_TIMEOUT_MS = 30_000;
export const CALL_TIMEOUT_MS = 5 * 60_000;
/** Of a call's text, past which it is cut with "[truncated]". */
export const MAX_RESULT_TEXT = 200_000;
const MAX_DESCRIPTION = 4000;
/** Pages of `tools/list` read at most (each page counts towards the same byte budget). */
const MAX_PAGES = 64;

const Action = McpAction.extend({ outputSchema: McpAction.shape.inputSchema.optional(), readOnly: z.literal(true).optional() });

/** NUL and lone surrogates become U+FFFD, so the value fits Postgres text and JSONB. */
function storable<T>(value: T): T {
  if (typeof value === "string") return value.toWellFormed().replaceAll("\u0000", "�") as T;
  if (Array.isArray(value)) return value.map(storable) as T;
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [storable(k), storable(v)])) as T;
  return value;
}

function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let e = error; e !== undefined && chain.length < 10; e = e instanceof Error ? e.cause : undefined) chain.push(e);
  return chain;
}

/** The short reason of a failure: never the error's own message, which may quote the server's answer. */
function reason(error: unknown, host: string, timedOut: boolean): ToolError {
  const chain = causes(error);
  const own = chain.find((e) => e instanceof ToolError);
  if (own) return own as ToolError;
  const blocked = chain.find((e) => e instanceof BlockedAddressError);
  if (blocked) return new ToolError(`${host} is one of Dispand's own addresses`);
  if (timedOut) return new ToolError(`${host} didn't answer in time`);
  const http = chain.find((e) => e instanceof SdkHttpError);
  if (http) {
    const { status } = http;
    if (status === 401 || status === 403) return new ToolError(`${host} refused the request (${status}): check the headers`);
    if (status >= 300 && status < 400) return new ToolError(`${host} redirected the request elsewhere: enter the address it points to`);
    return new ToolError(`${host} answered ${status}`);
  }
  if (chain.some((e) => e instanceof SdkError && e.code === SdkErrorCode.RequestTimeout)) return new ToolError(`${host} didn't answer in time`);
  if (chain.some((e) => e instanceof OAuthError || e instanceof UnauthorizedError)) return new ToolError(`${host}'s sign-in failed`);
  return new ToolError(`Couldn't reach ${host}`);
}

/**
 * The transport for one connection, over `fetcher` (which screens every response). Requests the
 * server sends the client are dropped before the SDK sees them: Dispand offers no client
 * capability, and the SDK would answer each one with a request of its own, so a server could
 * make it open any number of them.
 */
function transportFor(target: ToolTarget, fetcher: typeof fetch, authProvider?: OAuthClientProvider): Transport {
  const url = new URL(target.url);
  // An OAuth connection's requests (the flow's included) are https only, and its token refusals bare.
  const fetch = authProvider ? httpsOnly(bareTokenErrors(fetcher)) : fetcher;
  const options = { requestInit: { headers: target.headers }, fetch, redirectPolicy: "same-origin" as const, ...(authProvider ? { authProvider } : {}) };
  const inner: Transport = target.transport === "sse" ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, options);
  return new Proxy(inner, {
    set(t, property, value: unknown) {
      if (property === "onmessage" && typeof value === "function") {
        const handle = value as NonNullable<Transport["onmessage"]>;
        t.onmessage = (message, extra) => {
          if ("method" in message && "id" in message) return;
          handle(message, extra);
        };
        return true;
      }
      return Reflect.set(t, property, value);
    },
  });
}

/**
 * Opens a connection, runs `work` on it, then closes it: one connection per listing or call. The
 * whole of it, connecting included, ends at `timeoutMs` or when `signal` aborts.
 */
async function withClient<T>(
  target: ToolTarget,
  base: typeof fetch,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  work: (client: Client, options: { signal: AbortSignal; timeout: number }) => Promise<T>,
  /** An OAuth tool's provider, and how it gives back its refresh turn once the connection ends. */
  auth?: { provider: OAuthClientProvider; release(): void },
): Promise<T> {
  const host = new URL(target.url).host;
  const deadline = AbortSignal.timeout(timeoutMs);
  const both = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const client = new Client({ name: "dispand", version: "1.0.0" });
  const options = { signal: both, timeout: timeoutMs };
  let stop!: (reason: unknown) => void;
  const stopped = new Promise<never>((_, reject) => (stop = reject));
  stopped.catch(() => undefined);
  const screen = screenedFetch(base, (error) => stop(error));
  const transport = transportFor(target, screen.fetch, auth?.provider);
  const onAbort = () => stop(both.reason);
  both.addEventListener("abort", onAbort, { once: true });
  try {
    if (both.aborted) throw both.reason;
    return await Promise.race([
      (async () => {
        await client.connect(transport, options);
        return work(client, options);
      })(),
      stopped,
    ]);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    const refused = screen.refused();
    if (refused) throw new ToolError(`${host} ${refused}`);
    if (signal?.aborted) throw new ToolError("The call was cancelled");
    throw reason(error, host, deadline.aborted);
  } finally {
    both.removeEventListener("abort", onAbort);
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    auth?.release();
  }
}

/** The last segment of a resource's URI, as the file's name (redacted: the server may echo the headers there). */
function nameOf(uri: string, clean: (text: string) => string): string {
  const path = uri.split(/[?#]/)[0] ?? "";
  return clean(decodeURIComponentSafe(path.slice(path.lastIndexOf("/") + 1))) || "file";
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The files of a result: its images and the embedded resources that carry a blob, in order. */
function filesOf(result: CallToolResult, clean: (text: string) => string): ToolFile[] {
  const files: ToolFile[] = [];
  for (const part of result.content) {
    if (part.type === "image") files.push({ name: "image", bytes: Buffer.from(part.data, "base64") });
    else if (part.type === "resource" && "blob" in part.resource) files.push({ name: nameOf(part.resource.uri, clean), bytes: Buffer.from(part.resource.blob, "base64") });
  }
  return files;
}

function summarize(result: CallToolResult, clean: (text: string) => string): string {
  const parts = result.content.map((part) => {
    switch (part.type) {
      case "text":
        return clean(part.text);
      case "image":
        return "[image]";
      case "audio":
        return "[audio]";
      case "resource":
        return `[resource ${clean(part.resource.uri)}]`;
      case "resource_link":
        return `[resource ${clean(part.uri)}]`;
      default:
        return `[${clean((part as { type: string }).type)}]`;
    }
  });
  const text = parts.join("\n");
  return text.length > MAX_RESULT_TEXT ? `${text.slice(0, MAX_RESULT_TEXT)}\n[truncated]` : text;
}

/** An OAuth error code, as RFC 6749 spells them. */
const ERROR_CODE = /^[a-z_]{1,64}$/;

/**
 * A token endpoint's refusal (a form posted, an answer with an `error`, whatever its status; or
 * any answer not ok) reduced to its error code: the SDK logs a refusal's description on the
 * console, and a server may quote a token or a secret there. `inner` is the connection's screened
 * fetch, so the body read here is already within the connection's byte budget.
 */
export function bareTokenErrors(inner: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await inner(input, init);
    // A redirect stays as it is: the SDK follows it within the origin, or refuses it.
    if ((response.status >= 300 && response.status < 400) || !(init?.body instanceof URLSearchParams)) return response;
    const text = await response.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON: the SDK refuses it.
    }
    const error = (body as { error?: unknown } | null)?.error;
    if (response.ok && error === undefined) return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
    const code = typeof error === "string" && ERROR_CODE.test(error) ? error : "server_error";
    return new Response(JSON.stringify({ error: code }), { status: response.status, statusText: response.statusText, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

/** Loopback hosts, where plain http stays on this machine. */
const loopback = (url: URL) => url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);

/**
 * An OAuth connection's fetch refuses plain http but to this machine, before connecting: the
 * server names the addresses of its flow (metadata, registration, token), and an observer could
 * otherwise swap the token endpoint the client secret and the code go to.
 */
export function httpsOnly(inner: typeof fetch): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "https:" && !loopback(url)) return Promise.reject(new ToolError(`${url.host} isn't reached over https: its sign-in is refused`));
    return inner(input, init);
  }) as typeof fetch;
}

/**
 * The MCP connector (SDK client over Streamable HTTP or SSE). `fetch` is the network policy:
 * production passes `guardedFetch(ownAddresses())`, and the SDK makes every request of an OAuth
 * flow (discovery, registration, token, refresh) through it too. Redirects are followed only
 * within the origin of the request (the SDK's own rule, for the transport and the flow alike), so
 * headers, codes, verifiers, client secrets and tokens never go to another host. A connection
 * reads at most 16 MiB. `appUrl` is the application's public URL, which OAuth tools need (the
 * callback and the client metadata document).
 */
export function createMcpConnector(opts: { fetch?: typeof fetch; appUrl?: string } = {}): ToolConnector {
  const fetcher = opts.fetch ?? fetch;
  return {
    listActions,
    callAction,
    authorize,
    finishAuthorization,
  };

  function provider(store: OAuthStore, mode: OAuthMode, secrets: Set<string>) {
    if (!opts.appUrl) throw new ToolError("OAuth sign-in needs the application's URL");
    return createOAuthProvider(store, mode, opts.appUrl, secrets);
  }

  /**
   * A listing's or call's provider: it may refresh, never starts a flow. `secrets` gets every
   * token and client secret the tool holds now, and those the connection gets later.
   */
  async function using(target: ToolTarget, secrets: Set<string>) {
    if (!target.oauth) return undefined;
    for (const secret of stateSecrets(await target.oauth.read())) secrets.add(secret);
    return provider(target.oauth, { kind: "use" }, secrets);
  }

  async function authorize(target: ToolTarget & { oauth: OAuthStore }) {
    const oauth = provider(target.oauth, { kind: "authorize" }, new Set());
    try {
      // Connecting without a token gets the server's 401, whose challenge names its resource
      // metadata; the SDK then runs discovery and hands the authorization URL to the provider.
      await withClient(target, fetcher, LIST_TIMEOUT_MS, undefined, async () => undefined, oauth);
      return null;
    } catch (error) {
      const started = oauth.started();
      if (started) return started;
      if (oauth.needsClient()) throw new ToolError(`${new URL(target.url).host}'s authorization server supports neither client metadata documents nor registration: enter the client id it gave you`);
      throw error;
    }
  }

  async function finishAuthorization(target: ToolTarget & { oauth: OAuthStore }, pending: NonNullable<OAuthState["pending"]>, params: URLSearchParams) {
    const host = new URL(target.url).host;
    const oauth = provider(target.oauth, { kind: "finish", pending }, new Set());
    const screen = screenedFetch(fetcher, () => undefined);
    const transport = transportFor(target, screen.fetch, oauth.provider) as StreamableHTTPClientTransport | SSEClientTransport;
    const finished = (async () => {
      // Through the proxy: `finishAuth` is the transport's own.
      await (transport as unknown as { finishAuth(p: URLSearchParams): Promise<void> }).finishAuth(params);
    })();
    try {
      await Promise.race([finished, new Promise<never>((_, reject) => AbortSignal.timeout(LIST_TIMEOUT_MS).addEventListener("abort", () => reject(new ToolError(`${host} didn't answer in time`)), { once: true }))]);
    } catch (error) {
      if (error instanceof ToolError) throw error;
      const refused = screen.refused();
      if (refused) throw new ToolError(`${host} ${refused}`);
      throw reason(error, host, false);
    } finally {
      await transport.close().catch(() => undefined);
    }
  }

  async function listActions(target: ToolTarget): Promise<ToolAction[]> {
      const secrets = new Set<string>();
      const auth = await using(target, secrets);
      const tools = await withClient(target, fetcher, LIST_TIMEOUT_MS, undefined, async (client, options) => {
        const all: Tool[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
          // One page per request: `listTools()` without a cursor would read every page before returning.
          const listed = await client.request({ method: "tools/list", params: cursor === undefined ? {} : { cursor } }, options);
          all.push(...listed.tools);
          if (all.length > MAX_ACTIONS) throw new ToolError(`The server offers more than ${MAX_ACTIONS} actions`);
          cursor = listed.nextCursor;
          if (!cursor) return all;
        }
        throw new ToolError(`The server lists its actions on more than ${MAX_PAGES} pages`);
      }, auth);
      // The server got the headers and may send them back: each field the action keeps is redacted
      // before anything reads or cuts it (fields one by one, so the result keeps its own shape).
      const clean = <T>(value: T) => storable(redact(value, target.headers, [...(target.urlSecrets ?? []), ...secrets]));
      return tools.map((tool) => {
        const candidate = {
          name: clean(tool.name),
          description: clean(tool.description ?? "").slice(0, MAX_DESCRIPTION),
          inputSchema: clean(tool.inputSchema),
          ...(tool.outputSchema ? { outputSchema: clean(tool.outputSchema) } : {}),
          ...(tool.annotations?.readOnlyHint === true ? { readOnly: true as const } : {}),
        };
        const name = candidate.name.slice(0, 100);
        for (const schema of [candidate.inputSchema, candidate.outputSchema]) {
          if (schema !== undefined && JSON.stringify(schema).length > MAX_SCHEMA_BYTES) {
            throw new ToolError(`The schema of the action “${name}” is larger than 64 KiB`);
          }
        }
        const parsed = Action.safeParse(candidate);
        if (!parsed.success) throw new ToolError(`The action “${name}” isn't valid: ${z.prettifyError(parsed.error).slice(0, 200)}`);
        return parsed.data as ToolAction;
      });
  }

  async function callAction(target: ToolTarget, action: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
      const secrets = new Set<string>();
      const auth = await using(target, secrets);
      const result = await withClient(target, fetcher, CALL_TIMEOUT_MS, signal, (client, options) => client.callTool({ name: action, arguments: args }, options), auth);
      // The server got the headers and may send them back: redacted before the text is cut.
      const clean = <T>(value: T) => storable(redact(value, target.headers, [...(target.urlSecrets ?? []), ...secrets]));
      const structured = result.structuredContent;
      const files = filesOf(result, clean);
      return {
        text: storable(summarize(result, clean)),
        ...(structured && typeof structured === "object" && !Array.isArray(structured) ? { structured: clean(structured as Record<string, unknown>) } : {}),
        isError: result.isError === true,
        ...(files.length > 0 ? { files } : {}),
        ...(result._meta?.result_has_more === true ? { hasMore: true } : {}),
      };
  }
}
