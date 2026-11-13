import { HarnessEvent, type QuestionPayload } from "@dispand/runner-protocol";
import { expect, test } from "vitest";
import { fitsWhole, FRAME_BUDGET, protocolEvents, protocolString } from "./sanitize.ts";

test("native rule metadata is preserved whole or the permission question is refused", () => {
  const event: HarnessEvent = { type: "question", questionId: "q", payload: { kind: "permission", toolName: "Bash", input: { command: "npm test" }, canAlwaysAllow: false, remembers: "Bash(npm test:*)" } };
  expect(fitsWhole(event)).toBe(true);
  expect(protocolEvents(event)).toEqual([event]);
  if (event.payload.kind !== "permission") throw new Error("permission fixture");
  for (const remembers of ["x".repeat(1001), "Bash\u0000", "Bash\ud800"]) {
    const invalid = { ...event, payload: { ...event.payload, remembers } };
    expect(fitsWhole(invalid)).toBe(false);
    expect(protocolEvents(invalid)).toEqual([{ type: "error", message: "a permission prompt too large to show for approval was dropped" }]);
  }
});

// Lone surrogates, NUL, and lengths past every maximum: what a CLI could hand the runner.
const bad = (n: number) => `\u0000\ud800${"é".repeat(n)}\udc00`;
const huge = bad(300_000);

const choice: QuestionPayload = {
  kind: "choice",
  questions: Array.from({ length: 30 }, () => ({
    question: bad(5000),
    header: bad(5000),
    options: Array.from({ length: 60 }, () => ({ label: bad(5000), description: bad(5000) })),
    multiSelect: false,
  })),
};

// One pathological instance of every event type: adding a type to the protocol fails here until it is covered.
const cases: Record<HarnessEvent["type"], unknown> = {
  "cli-session": { type: "cli-session", cliSessionId: bad(300) },
  text: { type: "text", delta: huge },
  tool: { type: "tool", name: bad(300), status: "started" },
  question: { type: "question", questionId: bad(300), payload: choice },
  "turn-end": { type: "turn-end" },
  "outputs-accepted": { type: "outputs-accepted", values: { summary: huge } },
  result: { type: "result", text: huge },
  error: { type: "error", message: huge },
};
const more: [string, unknown][] = [
  ["permission with a huge input", { type: "question", questionId: "q", payload: { kind: "permission", toolName: bad(300), input: { content: huge }, canAlwaysAllow: true } }],
  ["permission with 150,000 newlines (escaped twice in a preview)", { type: "question", questionId: "q", payload: { kind: "permission", toolName: "Write", input: { content: "\n".repeat(150_000) }, canAlwaysAllow: true } }],
  ["permission with an unstorable key", { type: "question", questionId: "q", payload: { kind: "permission", toolName: "Bash", input: { [bad(3)]: [bad(3)] }, canAlwaysAllow: false } }],
  ["confirm-outputs", { type: "question", questionId: "q", payload: { kind: "confirm-outputs", values: { a: bad(10), [bad(3)]: "x" } } }],
];

test.each([...Object.entries(cases), ...more])("%s comes out as events the protocol accepts, each within a frame", (_name, event) => {
  const out = protocolEvents(event as HarnessEvent);
  expect(out.length).toBeGreaterThan(0);
  for (const e of out) {
    expect(HarnessEvent.safeParse(e).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(e))).toBeLessThanOrEqual(FRAME_BUDGET);
  }
});

test("long text is split, not cut: the deltas add up to the sanitized text", () => {
  const delta = `${"ab".repeat(150_000)}😀${"€".repeat(100_000)}`;
  const out = protocolEvents({ type: "text", delta });
  expect(out.length).toBeGreaterThan(1);
  expect(out.map((e) => (e.type === "text" ? e.delta : "")).join("")).toBe(delta);
});

test("well-formed strings within bounds pass unchanged", () => {
  const event: HarnessEvent = { type: "result", text: "Hello 👋, ça va ?" };
  expect(protocolEvents(event)).toEqual([event]);
  expect(protocolString("2.1.311", 200)).toBe("2.1.311");
});

test("a cut never leaves half a surrogate pair", () => {
  expect(protocolString("a😀", 2)).toBe("a�");
});

test("a permission question is never sent with a cut input: one too large becomes an error", () => {
  for (const content of ["é".repeat(300_000), "\n".repeat(150_000)]) {
    const out = protocolEvents({ type: "question", questionId: "q", payload: { kind: "permission", toolName: "Write", input: { content }, canAlwaysAllow: true } });
    expect(out).toEqual([{ type: "error", message: expect.stringContaining("too large to show") }]);
  }
});
