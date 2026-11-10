import { isJsonContentType } from "@modelcontextprotocol/client";

/**
 * Everything an MCP server sends passes here, in the connection's `fetch`, before the SDK reads a
 * byte of it: the byte budget and the bound on what one message may hold, so no SDK parsing or
 * validation runs on what wasn't checked. `redact` is applied to what the SDK returns, before
 * anything else reads it.
 */

export const MAX_ACTIONS = 200;
/**
 * What one connection (one listing or call) reads from the server, every response and the whole
 * SSE stream together, counted as it arrives.
 */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** JSON values (objects, arrays, scalars) in one message from the server, at most. */
export const MAX_MESSAGE_VALUES = 100_000;

/** A response the screen refused; `reason` follows the host in the owner's error ("<host> <reason>"). */
export class InboundRefused extends Error {
  override name = "InboundRefused";
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Why a parsed message is refused, if it is: the SDK's validation works per value, so its cost is bounded here. */
export function inboundProblem(message: unknown): string | undefined {
  let values = 0;
  const stack: unknown[] = [message];
  while (stack.length) {
    const value = stack.pop();
    if (++values > MAX_MESSAGE_VALUES) return "sent a message too large to read";
    if (Array.isArray(value)) for (const item of value) stack.push(item);
    else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) stack.push(item);
  }
  const tools = (message as { result?: { tools?: unknown } } | null)?.result?.tools;
  if (Array.isArray(tools) && tools.length > MAX_ACTIONS) return `offers more than ${MAX_ACTIONS} actions`;
  return undefined;
}

/** Authentication scheme names: the only words of a header value that may come back. */
const SCHEMES = new Set(["bearer", "basic", "token", "digest", "apikey"]);

/**
 * What of the headers must not come back: each value, and each word of it but a scheme name,
 * whatever their length (a short key is still a key); and each secret the URL holds.
 */
function secretsOf(headers: Record<string, string>, urlSecrets: string[]): string[] {
  const found = new Set<string>(urlSecrets.filter(Boolean));
  for (const value of Object.values(headers)) {
    if (value) found.add(value);
    for (const word of value.split(/\s+/)) if (word && !SCHEMES.has(word.toLowerCase())) found.add(word);
  }
  return [...found].sort((a, b) => b.length - a.length);
}

/**
 * `value` with every header value, and every secret the URL holds, replaced by "••••", in every
 * string and key. The server got them, so anything it sends back (names, descriptions, results)
 * may hold them. URL secrets sit only in the path or query and hold only characters a URL keeps
 * as they are (`URL_SECRET`), so the server sees them spelled exactly so.
 */
export function redact<T>(value: T, headers: Record<string, string>, urlSecrets: string[] = []): T {
  const secrets = secretsOf(headers, urlSecrets);
  if (secrets.length === 0) return value;
  const clean = (v: unknown): unknown => {
    if (typeof v === "string") return secrets.reduce((text, secret) => text.replaceAll(secret, "••••"), v);
    if (Array.isArray(v)) return v.map(clean);
    if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, item]) => [clean(k), clean(item)]));
    return v;
  };
  return clean(value) as T;
}

/** Refuses a message past the bounds; the text itself goes on unchanged (text that isn't JSON too: the SDK refuses it). */
function checkJson(text: string): void {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return;
  }
  const problem = inboundProblem(value);
  if (problem) throw new InboundRefused(problem);
}

type Emit = (text: string) => void;

/** Server-sent events, each passed on whole once its data is checked as one message. */
function checkEvents() {
  let pending = "";
  let lines: string[] = [];
  let data: string[] = [];
  const line = (text: string, emit: Emit) => {
    if (text === "") {
      if (data.length) checkJson(data.join("\n"));
      if (lines.length) emit(`${lines.join("\n")}\n\n`);
      lines = [];
      data = [];
      return;
    }
    lines.push(text);
    if (text.startsWith("data:")) data.push(text.slice(text.startsWith("data: ") ? 6 : 5));
  };
  return {
    push(chunk: string, emit: Emit) {
      const split = (pending + chunk).split(/\r\n|\r|\n/);
      pending = split.pop() ?? "";
      for (const text of split) line(text, emit);
    },
    end(emit: Emit) {
      if (pending) line(pending, emit);
      line("", emit);
    },
  };
}

/**
 * The `fetch` of one connection: `inner` (the network policy) with every response body counted
 * against `MAX_RESPONSE_BYTES`, and each message (a body, or an event of a stream) checked with
 * `inboundProblem` before the SDK reads it. Nothing is rewritten: redaction is done on what the
 * SDK returns (`redact`). `refused()` says why a response was refused, if one was.
 */
export function screenedFetch(
  inner: typeof fetch,
  /** Called at the first refusal: the SDK may not notice a stream that failed, so the caller ends the connection. */
  onRefused: (error: InboundRefused) => void,
): { fetch: typeof fetch; refused(): string | undefined } {
  let seen = 0;
  let refused: string | undefined;
  /** Runs `step`; a refusal is remembered before it errors the stream. */
  const guarded = <T>(step: () => T): T => {
    try {
      return step();
    } catch (error) {
      if (error instanceof InboundRefused && refused === undefined) {
        refused = error.reason;
        onRefused(error);
      }
      throw error;
    }
  };
  const counted = (body: ReadableStream<Uint8Array>) =>
    body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          seen += chunk.byteLength;
          guarded(() => {
            if (seen > MAX_RESPONSE_BYTES) throw new InboundRefused("sent more than 16 MiB");
          });
          controller.enqueue(chunk);
        },
      }),
    );
  const screened = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await inner(input, init);
    if (!response.body) return response;
    const type = response.headers.get("content-type") ?? "";
    const out = new Headers(response.headers);
    out.delete("content-length");
    const meta = { status: response.status, statusText: response.statusText, headers: out };
    // An event stream exactly when the SDK reads one (its own media-type parsing); any other body is read whole.
    if (!isJsonContentType(type) && type.split(";")[0]!.trim().toLowerCase() === "text/event-stream") {
      const events = checkEvents();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      const body = counted(response.body).pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform: (chunk, controller) =>
            guarded(() => events.push(decoder.decode(chunk, { stream: true }), (text) => controller.enqueue(encoder.encode(text)))),
          flush: (controller) => guarded(() => events.end((text) => controller.enqueue(encoder.encode(text)))),
        }),
      );
      return new Response(body, meta);
    }
    // Read whole (within the budget), so the SDK gets a checked message or nothing, whatever its declared type.
    const text = await new Response(counted(response.body)).text();
    guarded(() => checkJson(text));
    return new Response(text, meta);
  };
  return { fetch: screened as typeof fetch, refused: () => refused };
}
