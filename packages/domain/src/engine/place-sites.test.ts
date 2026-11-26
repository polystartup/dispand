import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// Every call from the engine to a harness (`this.adapter`), to the cloud runner (`this.cloud`) or
// to a Tool step's tool (`this.toolSteps`), and every write of a session's delivery state, sits in
// a function listed here, which says why it may run where it runs. A new one fails until it is
// listed, so whoever adds it decides whether it asks the gate (`PlaceGate`).

const DIR = import.meta.dirname;
// The adapter the engine calls through is no caller of its own.
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "routing-adapter.ts");
const CALL = /this\.(adapter|cloud|toolSteps)\??\s*\.\s*(\w+)\s*(?:\?\.)?\(/g;
// What says whether a start, an answer or a chat message reached its session.
const DELIVERY = /\b(deliveredAt|delivering|startDeliveredAt|startConnection|resumeAfterSession|codexInputId)\s*:/g;

/**
 * - gated: asks the gate (`this.gate`) before each such call or write and each call of a holder, or makes
 *   them in the arguments of a gated function (the callback `sendClaimed` runs once its gate admits).
 * - holder: runs only where the place is held; each of its callers in the engine is listed too.
 * - forwarded: what it sends goes through an entry a process sharing the database wraps to reach the
 *   holder (the adapter's method, or this entry itself).
 * - local: this process's own runner, not a place.
 * - row: writes a session's rows and sends nothing; whatever then sends them is gated.
 */
type Kind = "gated" | "holder" | "forwarded" | "local" | "row";

/** `file#function`: its kind, and why. */
const CLASSIFIED: Record<string, [Kind, string]> = {
  "engine.ts#narrowSessions": ["forwarded", "narrowing goes out through the hub's send (the CLI adapter), which a process sharing the database wraps to reach the runner's holder, or through the cloud runner's entries"],
  "engine.ts#interruptChat": ["forwarded", "an interrupt's waiter lives with the holder: the entry runs there"],
  "engine.ts#stopSession": ["forwarded", "a stop goes out through the hub's send (the CLI adapter), wrapped as narrowing is, or through the cloud runner's entries"],
  "engine.ts#handOver": ["gated", "handOver, before its claim writes and the cloud runner's resumeQueued"],
  "engine.ts#recoverHere": ["local", "the cloud runner it recovers is this process's own; its sessions are then reconciled step by step (gated)"],
  "engine.ts#stop": ["local", "closes this process's own cloud runner"],
  "engine.ts#reconcile": ["gated", "reconcile, for each step it lists"],
  "engine.ts#deliver": ["holder", "public code never calls it; a process sharing the database calls it for steps whose place it holds"],
  "engine.ts#resume": ["gated", "resume, before it claims the start"],
  "engine.ts#resumeClaimed": ["holder", "runs under a start claim its gated caller took"],
  "engine.ts#unconfirm": ["holder", "a lost session, found by its holder"],
  "engine.ts#unconfirmNow": ["holder", "a lost session, found by its holder"],
  "engine.ts#retired": ["holder", "a session-ended event or a runner's report, both from the holder"],
  "engine.ts#apply": ["holder", "applies a session's own event, which comes from its holder"],
  "engine.ts#applyEvent": ["holder", "applies a session's own event, which comes from its holder"],
  "engine.ts#handleEvent": ["holder", "a session's own event, which comes from its holder"],
  "engine.ts#onHarnessEvent": ["holder", "called by the hub for the runner connected here, and by onCloudEvent"],
  "engine.ts#onCloudEvent": ["holder", "called by this process's cloud runner for the session it drives"],
  "engine.ts#dropSteers": ["holder", "a lost or ended session's steers, found by its holder"],
  "engine.ts#startTool": ["gated", "tool, before the step's claim"],
  "engine.ts#launch": ["gated", "launch, before claimStart and the grant"],
  "engine.ts#dispatch": ["holder", "launch's, after its gate"],
  "engine.ts#deliverAnswer": ["gated", "answer, in sendClaimed, which runs its write"],
  "engine.ts#deliverMessage": ["gated", "message, in sendClaimed, which runs its write"],
  "engine.ts#sendClaimed": ["gated", "answer or message, before its hold or its claim"],
  "engine.ts#claimInputs": ["holder", "claims for a delivery or a resume, both past the gate"],
  "engine.ts#delivered": ["holder", "ends a claim taken past the gate"],
  "engine.ts#giveBack": ["holder", "ends a claim taken past the gate"],
  "engine.ts#admitCodexInput": ["holder", "a delivery's write, past the gate"],
  "step-lifecycle.ts#NO_TURN": ["row", "a new session's rows: its start goes through launch (gated)"],
  "step-lifecycle.ts#NEW_SESSION": ["row", "a new session's rows: its start goes through launch (gated)"],
  "step-lifecycle.ts#replacement": ["row", "a new session's rows: its start goes through resume (gated)"],
  "step-lifecycle.ts#reopen": ["row", "a reopened chat's rows: what it sends goes through resume or launch (gated)"],
};

/** Where the engine asks for each kind of work (`this.admits("…"`), by function: a move or a new ask fails until listed. */
const ASKED: Record<string, string[]> = {
  launch: ["launch"],
  resume: ["resume"],
  handOver: ["handOver"],
  wake: ["wake"],
  flush: ["answer"],
  answer: ["redeliverAnswer", "sendClaimed"],
  message: ["sendClaimed"],
  reconcile: ["reconcile"],
  tool: ["startTool"],
  failTool: ["failInterruptedTools"],
};

type Site = { file: string; fn: string; at: number; what: string };

/** The function or method each offset of `text` is in: the last declaration before it, at the top level or a class's. */
function enclosing(text: string): (at: number) => string {
  const DECL = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=|^ {2}(?:(?:private|public|protected|static|readonly)\s+)*(?:async\s+)?(?:get\s+)?(\w+)\s*[<(].*[{(]$/gm;
  const decls = [...text.matchAll(DECL)].filter((m) => !["if", "for", "while", "switch", "return", "catch"].includes(m[3] ?? "")).map((m) => [m.index, m[1] ?? m[2] ?? m[3]!] as const);
  return (at) => decls.filter(([i]) => i <= at).at(-1)?.[1] ?? "";
}

/** Where the parenthesis opened at `open` closes (strings and comments aside: the engine's calls hold none that unbalance). */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return text.length;
}

function sites(): { all: Site[]; texts: Map<string, string> } {
  const all: Site[] = [];
  const texts = new Map<string, string>();
  for (const file of FILES) {
    const text = readFileSync(join(DIR, file), "utf8");
    texts.set(file, text);
    const fnAt = enclosing(text);
    for (const m of text.matchAll(CALL)) all.push({ file, fn: fnAt(m.index), at: m.index, what: `${m[1]}.${m[2]}` });
    for (const m of text.matchAll(DELIVERY)) all.push({ file, fn: fnAt(m.index), at: m.index, what: m[1]! });
  }
  return { all, texts };
}

test("every adapter and cloud runner call site is classified", () => {
  const { all, texts } = sites();
  const key = (s: { file: string; fn: string }) => `${s.file}#${s.fn}`;
  const holders = Object.entries(CLASSIFIED).filter(([, [kind]]) => kind === "holder").map(([k]) => k);
  // Calls of a holder from the engine itself: `this.name(`.
  const holderCalls = holders.flatMap((h) => {
    const [file, fn] = h.split("#") as [string, string];
    const text = texts.get(file)!;
    const fnAt = enclosing(text);
    return [...text.matchAll(new RegExp(`this\\.${fn}\\(`, "g"))].map((m) => ({ file, fn: fnAt(m.index), at: m.index, what: `calls ${fn}` }));
  });
  // Every function with a site, or calling a holder, is listed; nothing listed has neither.
  const found = new Set([...all, ...holderCalls].map(key));
  expect([...found].filter((k) => !CLASSIFIED[k]).sort()).toEqual([]);
  expect(Object.keys(CLASSIFIED).filter((k) => !found.has(k)).sort()).toEqual([]);
  // A gated function asks before each site and each call of a holder, or makes it in a gated call's arguments.
  const gated = Object.entries(CLASSIFIED).filter(([, [kind]]) => kind === "gated").map(([k]) => k);
  for (const site of [...all, ...holderCalls].filter((s) => gated.includes(key(s)))) {
    const text = texts.get(site.file)!;
    const fnAt = enclosing(text);
    const asked = [...text.matchAll(/this\.gate\b/g)].some((m) => fnAt(m.index) === site.fn && m.index < site.at);
    const inside = gated.flatMap((g) => {
      const [file, fn] = g.split("#") as [string, string];
      return file === site.file ? [...text.matchAll(new RegExp(`this\\.${fn}\\(`, "g"))] : [];
    }).some((m) => fnAt(m.index) === site.fn && m.index < site.at && site.at < closing(text, m.index + m[0].length - 1));
    expect(asked || inside, `${key(site)} asks the gate before ${site.what}`).toBe(true);
  }
});

test("each kind of work is asked where it is listed", () => {
  const text = readFileSync(join(DIR, "engine.ts"), "utf8");
  const fnAt = enclosing(text);
  const asked: Record<string, string[]> = {};
  for (const m of text.matchAll(/this\.admits\((?:\s*table === questions \? )?"(\w+)"(?: : "(\w+)")?/g)) {
    for (const work of [m[1]!, m[2]].filter((w): w is string => !!w)) (asked[work] ??= []).push(fnAt(m.index));
  }
  expect(Object.fromEntries(Object.entries(asked).map(([work, fns]) => [work, [...new Set(fns)].sort()]))).toEqual(ASKED);
});
