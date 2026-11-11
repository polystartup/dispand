import { createHash, randomBytes } from "node:crypto";
import { type Attributes, type AttributeValue, SpanKind } from "@opentelemetry/api";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, TimedEvent } from "@opentelemetry/sdk-trace";

// The last stage before anything is exported, ours or an instrumentation's: no secret and no
// error text leaves through telemetry. It removes what is known to carry them (secret-named
// attributes, headers, query strings and credentials in URLs, error messages and stacks) and any
// value equal to a secret this process opened. It never throws and never logs what it removes.

/** Attribute names (or their last segment) that hold a secret. */
const SECRET_NAMES = new Set(["authorization", "cookie", "set-cookie", "token", "code", "state", "api_key", "apikey", "password", "secret", "proxy-authorization"]);
/** Headers are never exported: they carry credentials. */
const HEADER = /^(http\.(request|response)\.header\.|http\.request\.headers?$|http\.response\.headers?$)/;
/** Attributes that hold a URL or a request target: kept without query string, fragment or credentials. */
const URLS = new Set(["url.full", "http.url", "http.target", "url.original", "server.url", "db.connection_string"]);
/** Attributes that hold only a query string. */
const QUERIES = new Set(["url.query", "http.query"]);
/** What of an exception event may leave: its kind. */
const EXCEPTION_KEEP = new Set(["exception.type"]);
/** Below this length a value is not taken for a secret: it would match too much. */
const MIN_SECRET = 8;

// Secrets the process opened, as salted hashes: a value equal to one is dropped. The plaintext
// is not kept, and the salt is new at each start.
const SALT = randomBytes(16);
const MAX_REMEMBERED = 10_000;
const remembered = new Set<string>();
const hash = (value: string) => createHash("sha256").update(SALT).update(value).digest("base64url");

/** Called with each secret's plaintext as it is opened (`secrets.ts`). */
export function rememberSecret(plain: string): void {
  if (plain.length < MIN_SECRET) return;
  if (remembered.size >= MAX_REMEMBERED) remembered.delete(remembered.values().next().value!);
  remembered.add(hash(plain));
}

const isSecret = (value: unknown) => typeof value === "string" && value.length >= MIN_SECRET && remembered.size > 0 && remembered.has(hash(value));

const secretName = (key: string) => {
  const lower = key.toLowerCase();
  return SECRET_NAMES.has(lower) || SECRET_NAMES.has(lower.slice(lower.lastIndexOf(".") + 1)) || HEADER.test(lower);
};

/** A URL or request target without its query string, fragment and credentials. */
function cleanUrl(value: string): string {
  const cut = value.split(/[?#]/, 1)[0]!;
  try {
    const url = new URL(cut);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return cut;
  }
}

function cleanValue(value: AttributeValue | undefined): AttributeValue | undefined {
  if (Array.isArray(value)) return (value as unknown[]).filter((v) => !isSecret(v)) as AttributeValue;
  return isSecret(value) ? undefined : value;
}

/** The attributes that may leave. */
export function redactAttributes(attributes: Attributes | undefined): Attributes {
  const out: Attributes = {};
  try {
    for (const [key, raw] of Object.entries(attributes ?? {})) {
      if (raw === undefined || raw === null || secretName(key) || QUERIES.has(key)) continue;
      const value = URLS.has(key) && typeof raw === "string" ? cleanUrl(raw) : raw;
      const kept = cleanValue(value);
      if (kept !== undefined) out[key] = kept;
    }
  } catch {
    return {};
  }
  return out;
}

function redactEvent(event: TimedEvent): TimedEvent {
  const attributes = event.name === "exception" ? Object.fromEntries(Object.entries(event.attributes ?? {}).filter(([k]) => EXCEPTION_KEEP.has(k))) : event.attributes;
  return { ...event, attributes: redactAttributes(attributes) };
}

/** Of a call out: only where it went. A tool's address may hold a secret in its path, not only in its query. */
const PATHS = ["url.path", "http.target", "url.template", "http.route"];
function outbound(attributes: Attributes): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (PATHS.includes(key)) continue;
    if ((key === "url.full" || key === "http.url") && typeof value === "string") {
      try {
        out[key] = new URL(value).origin;
      } catch {
        // Not a URL: nothing of it leaves.
      }
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** A span as it may leave: the same span, its attributes and events redacted, its status without a message. */
export function redactSpan(span: ReadableSpan): ReadableSpan {
  let events: TimedEvent[];
  try {
    events = (span.events ?? []).map(redactEvent);
  } catch {
    events = [];
  }
  return Object.create(span, {
    attributes: { value: span.kind === SpanKind.CLIENT ? outbound(redactAttributes(span.attributes)) : redactAttributes(span.attributes), enumerable: true },
    events: { value: events, enumerable: true },
    status: { value: span.status ? { code: span.status.code } : span.status, enumerable: true },
  }) as ReadableSpan;
}

/** A log record as it may leave. */
export function redactLogRecord(record: ReadableLogRecord): ReadableLogRecord {
  return Object.create(record, {
    attributes: { value: redactAttributes(record.attributes), enumerable: true },
    body: { value: isSecret(record.body) ? undefined : record.body, enumerable: true },
  }) as ReadableLogRecord;
}
