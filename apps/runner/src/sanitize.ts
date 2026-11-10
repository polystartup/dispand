import { isDeepStrictEqual } from "node:util";
import { type HarnessEvent, ID, PERMISSION_INPUT, type QuestionPayload, SHORT, TEXT } from "@dispand/runner-protocol";

/** The hub refuses frames over 1 MiB: an event leaves room for its envelope (seq, session id). */
export const FRAME_BUDGET = 1024 * 1024 - 4096;
/** Long text deltas are split into pieces this long (at most 6 JSON bytes per character). */
export const TEXT_CHUNK = 32_000;

/**
 * `s` as the protocol stores it: at most `max` characters, NUL and lone surrogates (which
 * Postgres can't store) replaced with U+FFFD. A cut that splits a surrogate pair leaves U+FFFD.
 */
export function protocolString(s: string, max: number, maxBytes = Infinity): string {
  let out = s.slice(0, max).toWellFormed().replaceAll("\u0000", "�");
  // Shrink until its JSON form fits `maxBytes` (only the frame-size fallback sets it).
  for (let bytes = jsonBytes(out); bytes > maxBytes && out.length > 0; bytes = jsonBytes(out)) {
    out = out.slice(0, Math.floor((out.length * maxBytes) / bytes) - 1).toWellFormed();
  }
  return out;
}

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "");

/** A JSON value with every string and key storable. */
export function cleanJson(value: unknown, maxBytes: number): unknown {
  if (typeof value === "string") return protocolString(value, Infinity, maxBytes);
  if (Array.isArray(value)) return value.map((v) => cleanJson(v, maxBytes));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [protocolString(k, Infinity), cleanJson(v, maxBytes)]));
  }
  return value;
}

function values(record: Record<string, string>, maxBytes: number): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record)
      .slice(0, 100)
      .map(([k, v]) => [protocolString(k, ID), protocolString(v, TEXT, maxBytes)]),
  );
}

function payload(p: QuestionPayload, maxBytes: number): QuestionPayload {
  const s = (v: string) => protocolString(v, SHORT, maxBytes);
  if (p.kind === "choice") {
    return {
      kind: "choice",
      questions: p.questions.slice(0, 20).map((q) => ({
        question: s(q.question),
        header: s(q.header),
        options: q.options.slice(0, 50).map((o) => ({ label: s(o.label), ...(o.description === undefined ? {} : { description: s(o.description) }) })),
        multiSelect: q.multiSelect,
      })),
    };
  }
  if (p.kind === "confirm-outputs") return { kind: "confirm-outputs", values: values(p.values, maxBytes) };
  const input = cleanJson(p.input, maxBytes);
  return { kind: "permission", toolName: protocolString(p.toolName, ID), input, canAlwaysAllow: p.canAlwaysAllow };
}

function clean(e: HarnessEvent, maxBytes: number): HarnessEvent {
  switch (e.type) {
    case "cli-session":
      return { type: e.type, cliSessionId: protocolString(e.cliSessionId, ID) };
    case "text":
      return { type: e.type, delta: protocolString(e.delta, TEXT, maxBytes) };
    case "tool":
      return { type: e.type, name: protocolString(e.name, ID), status: e.status };
    case "question":
      return { type: e.type, questionId: protocolString(e.questionId, ID), payload: payload(e.payload, maxBytes) };
    case "turn-end":
      return e;
    case "outputs-accepted":
      return { type: e.type, values: values(e.values, maxBytes) };
    case "result":
      return { type: e.type, text: protocolString(e.text, TEXT, maxBytes) };
    case "error":
      return { type: e.type, message: protocolString(e.message, SHORT, maxBytes) };
  }
}

/** Whether `event` goes out exactly as it is: nothing replaced, cut or shrunk. */
export function fitsWhole(event: HarnessEvent): boolean {
  const out = clean(event, Infinity);
  return (
    isDeepStrictEqual(out, event) &&
    jsonBytes(out) <= FRAME_BUDGET &&
    (out.type !== "question" || out.payload.kind !== "permission" || (JSON.stringify(out.payload.input) ?? "").length <= PERMISSION_INPUT)
  );
}

/**
 * `event` as events the protocol accepts, each within a frame: strings made storable and cut to
 * their maxima, long text split into several deltas. Events already valid come out unchanged.
 */
export function protocolEvents(event: HarnessEvent): HarnessEvent[] {
  if (event.type === "text" && event.delta.length > TEXT_CHUNK) {
    const pieces: HarnessEvent[] = [];
    for (let i = 0; i < event.delta.length; ) {
      let end = Math.min(i + TEXT_CHUNK, event.delta.length);
      // Don't split a surrogate pair.
      if (end < event.delta.length && /[\ud800-\udbff]/.test(event.delta[end - 1]!)) end -= 1;
      pieces.push(clean({ type: "text", delta: event.delta.slice(i, end) }, Infinity));
      i = end;
    }
    return pieces;
  }
  // The owner approves exactly what a permission question shows: one too large to show whole is
  // never sent cut (`claude.ts` denies such requests before asking; this is the last guard).
  if (event.type === "question" && event.payload.kind === "permission" && !fitsWhole(event)) {
    return [{ type: "error", message: "a permission prompt too large to show for approval was dropped" }];
  }
  // Each string's bound in characters can still add up past a frame: halve what each string may take until it fits.
  let out = clean(event, Infinity);
  for (let maxBytes = FRAME_BUDGET / 2; jsonBytes(out) > FRAME_BUDGET; maxBytes /= 2) out = clean(event, maxBytes);
  return [out];
}
