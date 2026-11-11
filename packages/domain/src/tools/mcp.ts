import {
  Client,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import { McpAction } from "@dispand/runner-protocol";
import { z } from "zod";
import { MAX_ACTIONS, redact, screenedFetch } from "./inbound.ts";
import { BlockedAddressError } from "./network.ts";

export { inboundProblem, MAX_ACTIONS, MAX_MESSAGE_VALUES, MAX_RESPONSE_BYTES, redact } from "./inbound.ts";

export const TRANSPORTS = ["streamable-http", "sse"] as const;
export type ToolTransport = (typeof TRANSPORTS)[number];

/** Where an HTTP tool is and how to call it. `headers` are opened from the secret box just for the call. */
export type ToolTarget = {
  url: string;
  transport: ToolTransport;
  headers: Record<string, string>;
  /** Secrets the URL's path or query holds (a plugin server's settings): redacted like the headers. */
  urlSecrets?: string[];
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

/**
 * A failed listing or call, with a short reason made here (host, status), never the server's own
 * text: an error body or message may echo the headers.
 */
export class ToolError extends Error {
  override name = "ToolError";
}

/** The one way Dispand calls MCP servers over HTTP: actions for Settings → Tools, calls for agents and Tool steps. */
export type ToolConnector = {
  listActions(target: ToolTarget): Promise<ToolAction[]>;
  callAction(target: ToolTarget, action: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
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
  return new ToolError(`Couldn't reach ${host}`);
}

/**
 * The transport for one connection, over `fetcher` (which screens every response). Requests the
 * server sends the client are dropped before the SDK sees them: Dispand offers no client
 * capability, and the SDK would answer each one with a request of its own, so a server could
 * make it open any number of them.
 */
function transportFor(target: ToolTarget, fetcher: typeof fetch): Transport {
  const url = new URL(target.url);
  const options = { requestInit: { headers: target.headers }, fetch: fetcher, redirectPolicy: "same-origin" as const };
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
async function withClient<T>(target: ToolTarget, base: typeof fetch, timeoutMs: number, signal: AbortSignal | undefined, work: (client: Client, options: { signal: AbortSignal; timeout: number }) => Promise<T>): Promise<T> {
  const host = new URL(target.url).host;
  const deadline = AbortSignal.timeout(timeoutMs);
  const both = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const client = new Client({ name: "dispand", version: "1.0.0" });
  const options = { signal: both, timeout: timeoutMs };
  let stop!: (reason: unknown) => void;
  const stopped = new Promise<never>((_, reject) => (stop = reject));
  stopped.catch(() => undefined);
  const screen = screenedFetch(base, (error) => stop(error));
  const transport = transportFor(target, screen.fetch);
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

/**
 * The MCP connector (SDK client over Streamable HTTP or SSE). `fetch` is the network policy:
 * production passes `guardedFetch(ownAddresses())`. Redirects are followed only within the
 * tool's origin, so headers never go to another host, and a connection reads at most 16 MiB.
 */
export function createMcpConnector(opts: { fetch?: typeof fetch } = {}): ToolConnector {
  const fetcher = opts.fetch ?? fetch;
  return {
    listActions,
    callAction,
  };

  async function listActions(target: ToolTarget): Promise<ToolAction[]> {
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
      });
      // The server got the headers and may send them back: each field the action keeps is redacted
      // before anything reads or cuts it (fields one by one, so the result keeps its own shape).
      const clean = <T>(value: T) => storable(redact(value, target.headers, target.urlSecrets));
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
      const result = await withClient(target, fetcher, CALL_TIMEOUT_MS, signal, (client, options) => client.callTool({ name: action, arguments: args }, options));
      // The server got the headers and may send them back: redacted before the text is cut.
      const clean = <T>(value: T) => storable(redact(value, target.headers, target.urlSecrets));
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
