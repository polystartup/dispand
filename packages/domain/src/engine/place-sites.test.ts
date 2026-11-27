import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import { literal, match, named, onThis, optional, owner, parse, shape, statement, tokens, unwrap, where } from "../test-support-source.ts";

// Every call from the engine to a harness (`this.adapter`), to the cloud runner (`this.cloud`) or
// to a Tool step's tool (`this.toolSteps`), and every write of a session's delivery state, sits in
// a function listed here, which says why it may run where it runs. A new one fails until it is
// listed, so whoever adds it decides whether it asks the gate (`PlaceGate`). The sources are read as
// code (`test-support-source.ts`), not lines: what the former line regexes matched is found as runs
// of tokens, whatever the formatting, and each is placed in its function by the syntax tree.

const DIR = import.meta.dirname;
// The adapter the engine calls through is no caller of its own.
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "routing-adapter.ts");
const SOURCES = FILES.map((file) => ({ file, source: parse(file, readFileSync(join(DIR, file), "utf8")) }));
const DOT = [".", "?."];
const CALLEE = ["adapter", "cloud", "toolSteps"];
// What says whether a start, an answer or a chat message reached its session.
const DELIVERY = ["deliveredAt", "delivering", "startDeliveredAt", "startConnection", "resumeAfterSession", "codexInputId"];

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

/** `file#path` (`owner`'s path: a class's member, a top-level function or constant): its kind, and why. */
const CLASSIFIED: Record<string, [Kind, string]> = {
  "engine.ts#Engine.narrowSessions": [
    "forwarded",
    "narrowing goes out through the hub's send (the CLI adapter), which a process sharing the database wraps to reach the runner's holder, or through the cloud runner's entries",
  ],
  "engine.ts#Engine.interruptChat": ["forwarded", "an interrupt's waiter lives with the holder: the entry runs there"],
  "engine.ts#Engine.stopSession": [
    "forwarded",
    "a stop goes out through the hub's send (the CLI adapter), wrapped as narrowing is, or through the cloud runner's entries",
  ],
  "engine.ts#Engine.handOver": ["gated", "handOver, before its claim writes and the cloud runner's resumeQueued"],
  "engine.ts#Engine.recoverHere": ["local", "the cloud runner it recovers is this process's own; its sessions are then reconciled step by step (gated)"],
  "engine.ts#Engine.stop": ["local", "closes this process's own cloud runner"],
  "engine.ts#Engine.reconcile": ["gated", "reconcile, for each step it lists"],
  "engine.ts#Engine.deliver": ["holder", "public code never calls it; a process sharing the database calls it for steps whose place it holds"],
  "engine.ts#Engine.resume": ["gated", "resume, before it claims the start"],
  "engine.ts#Engine.resumeClaimed": ["holder", "runs under a start claim its gated caller took"],
  "engine.ts#Engine.unconfirm": ["holder", "a lost session, found by its holder"],
  "engine.ts#Engine.unconfirmNow": ["holder", "a lost session, found by its holder"],
  "engine.ts#Engine.retired": ["holder", "a session-ended event or a runner's report, both from the holder"],
  "engine.ts#Engine.apply": ["holder", "applies a session's own event, which comes from its holder"],
  "engine.ts#Engine.applyEvent": ["holder", "applies a session's own event, which comes from its holder"],
  "engine.ts#Engine.handleEvent": ["holder", "a session's own event, which comes from its holder"],
  "engine.ts#Engine.onHarnessEvent": ["holder", "called by the hub for the runner connected here, and by onCloudEvent"],
  "engine.ts#Engine.onCloudEvent": ["holder", "called by this process's cloud runner for the session it drives"],
  "engine.ts#Engine.dropSteers": ["holder", "a lost or ended session's steers, found by its holder"],
  "engine.ts#Engine.startTool": ["gated", "tool, before the step's claim"],
  "engine.ts#Engine.launch": ["gated", "launch, before claimStart and the grant"],
  "engine.ts#Engine.dispatch": ["holder", "launch's, after its gate"],
  "engine.ts#Engine.deliverAnswer": ["gated", "answer, in sendClaimed, which runs its write"],
  "engine.ts#Engine.deliverMessage": ["gated", "message, in sendClaimed, which runs its write"],
  "engine.ts#Engine.sendClaimed": ["gated", "answer or message, before its hold or its claim"],
  "engine.ts#Engine.claimInputs": ["holder", "claims for a delivery or a resume, both past the gate"],
  "engine.ts#Engine.delivered": ["holder", "ends a claim taken past the gate"],
  "engine.ts#Engine.giveBack": ["holder", "ends a claim taken past the gate"],
  "engine.ts#Engine.admitCodexInput": ["holder", "a delivery's write, past the gate"],
  "step-lifecycle.ts#NO_TURN": ["row", "a new session's rows: its start goes through launch (gated)"],
  "step-lifecycle.ts#NEW_SESSION": ["row", "a new session's rows: its start goes through launch (gated)"],
  "step-lifecycle.ts#replacement": ["row", "a new session's rows: its start goes through resume (gated)"],
  "step-lifecycle.ts#reopen": ["row", "a reopened chat's rows: what it sends goes through resume or launch (gated)"],
};

/** Where the engine asks for each kind of work (`this.admits("…"`), by function, once per ask: a move or a new ask fails until listed. */
const ASKED: Record<string, string[]> = {
  launch: ["Engine.launch"],
  resume: ["Engine.resume"],
  handOver: ["Engine.handOver"],
  wake: ["Engine.wake"],
  flush: ["Engine.answer"],
  answer: ["Engine.redeliverAnswer", "Engine.sendClaimed"],
  message: ["Engine.sendClaimed"],
  reconcile: ["Engine.reconcile"],
  tool: ["Engine.startTool"],
  failTool: ["Engine.failInterruptedTools"],
};

type Site = { file: string; at: ts.Node; what: string };
type Call = { call: ts.CallExpression | ts.NewExpression; self: ts.Node; names: string[] };

/** Every call on `this` in `source` (`this.launch(`, `this.adapter.send(`), read through `?.`, `!`, parentheses and `as`. */
function thisCalls(source: ts.SourceFile): Call[] {
  const calls: Call[] = [];
  const visit = (node: ts.Node) => {
    const on = (ts.isCallExpression(node) || ts.isNewExpression(node)) && onThis(node.expression);
    if (on) calls.push({ call: node, ...on });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}
const CALLS = new Map(SOURCES.map(({ file, source }) => [file, thisCalls(source)]));

/** The calls of `this.<names>` in `file`, which must hold every run of tokens `pattern` matches there (by its `this`): `unclaimed` gets the others. */
function callsOf(file: string, names: (call: Call) => boolean, pattern: Parameters<typeof match>[1], unclaimed: string[]): Call[] {
  const calls = CALLS.get(file)!.filter(names);
  for (const [self] of match(SOURCES.find((s) => s.file === file)!.source, pattern)) if (!calls.some((c) => c.self === self)) unclaimed.push(where(self!));
  return calls;
}

const isName = (token: ts.Node) => ts.isIdentifier(token) || ts.isPrivateIdentifier(token);
const delivery = (token: ts.Node) => named(...DELIVERY)(token) || (ts.isStringLiteral(token) && DELIVERY.includes(token.text));
const key = (site: Site) => `${site.file}#${owner(site.at)?.path ?? `? (${where(site.at)})`}`;
const kinds = (kind: Kind) =>
  Object.entries(CLASSIFIED)
    .filter(([, [k]]) => k === kind)
    .map(([k]) => k);

/**
 * Each call of an adapter, the cloud runner or a Tool step's tool (the old line regex's
 * `this.adapter.send(`, `this.cloud?.close?.(`, and calls only the tree shows, such as
 * `(this.adapter as A).send(`), each delivery field (`deliveredAt:` as a property, a type's member,
 * a parameter or a ternary's branch, as the old regex matched it; and a shorthand `{ deliveredAt }`),
 * and each call of a holder in its file (`this.retired(`).
 */
function sites(unclaimed: string[]): Site[] {
  return SOURCES.flatMap(({ file, source }) => {
    const callee = callsOf(
      file,
      (c) => c.names.length === 2 && CALLEE.includes(c.names[0]!),
      ["this", DOT, named(...CALLEE), optional("!"), DOT, isName, optional("!"), optional("?."), "("],
      unclaimed,
    ).map((c) => ({ file, at: c.self, what: c.names.join(".") }));
    const fields = [
      ...match(source, [delivery, ":"]).map(([name]) => name!),
      ...tokens(source).filter((t) => delivery(t) && ts.isShorthandPropertyAssignment(t.parent)),
    ].map((name) => ({ file, at: name, what: name.getText() }));
    const holderCalls = kinds("holder")
      .filter((h) => h.startsWith(`${file}#`))
      .flatMap((h) => {
        // Any `this.<holder>(` of the file, as the old regex took it, whichever class it is in.
        const member = h.split(".").at(-1)!.split(" ").at(-1)!; // `Engine.static dispatch` is called as `this.dispatch(`
        return callsOf(
          file,
          (c) => c.names.length === 1 && c.names[0] === member,
          ["this", DOT, named(member), optional("!"), optional("?."), "("],
          unclaimed,
        ).map((c) => ({ file, at: c.self, what: `calls ${member}` }));
      });
    return [...callee, ...fields, ...holderCalls];
  });
}

test("every adapter and cloud runner call site is classified", () => {
  const unclaimed: string[] = [];
  const all = sites(unclaimed);
  // A run of tokens the old line regexes matched that the tree shows as no such call: nothing to place it by.
  expect(unclaimed).toEqual([]);
  // Every function with a site, or calling a holder, is listed; nothing listed has neither.
  expect(all.filter((s) => !CLASSIFIED[key(s)]).map((s) => `${key(s)}: ${s.what} at ${where(s.at)}`)).toEqual([]);
  const found = new Set(all.map(key));
  expect(
    Object.keys(CLASSIFIED)
      .filter((k) => !found.has(k))
      .sort(),
  ).toEqual([]);
  // A gated function asks before each site and each call of a holder, or makes it in a gated call's
  // arguments. What lets it pass is exactly the old regexes' `this.gate` and `this.<gated>(`, in the
  // same function (by its declaration, not its name).
  const gated = kinds("gated");
  for (const site of all.filter((s) => gated.includes(key(s)))) {
    const { source } = SOURCES.find((s) => s.file === site.file)!;
    const fn = owner(site.at)!.node;
    const asked = match(source, ["this", ".", "gate"]).some(([self]) => owner(self!)?.node === fn && self!.getStart() < site.at.getStart());
    const members = gated.filter((g) => g.startsWith(`${site.file}#`)).map((g) => g.split(".").at(-1)!.split(" ").at(-1)!);
    const inside = match(source, ["this", ".", members, "("]).some(([self, , , open]) => {
      const call = open!.parent;
      return (
        owner(self!)?.node === fn &&
        (ts.isCallExpression(call) || ts.isNewExpression(call)) &&
        open!.getStart() < site.at.getStart() &&
        site.at.getEnd() <= call.getEnd()
      );
    });
    expect(asked || inside, `${key(site)} asks the gate before ${site.what} at ${where(site.at)}`).toBe(true);
  }
});

test("each kind of work is asked where it is listed", () => {
  const unclaimed: string[] = [];
  const either = shape((statement("table === questions") as ts.ExpressionStatement).expression);
  const asked: Record<string, string[]> = {};
  for (const { call } of callsOf(
    "engine.ts",
    (c) => c.names.length === 1 && c.names[0] === "admits",
    ["this", DOT, named("admits"), optional("!"), optional("?."), "("],
    unclaimed,
  )) {
    // A literal, or `table === questions ? "answer" : "message"`, which asks either; anything else (a
    // name holding one, say) fails, as what it asks can't be read here.
    const work = call.arguments?.[0] && unwrap(call.arguments[0]);
    const branches = work && ts.isConditionalExpression(work) && shape(work.condition) === either ? [work.whenTrue, work.whenFalse] : [work];
    for (const w of branches) {
      const kind = literal(w);
      expect(kind, `${where(call)}: ${call.getText()} asks a kind of work given as a literal`).toBeDefined();
      (asked[kind!] ??= []).push(owner(call)!.path);
    }
  }
  expect(unclaimed).toEqual([]);
  expect(Object.fromEntries(Object.entries(asked).map(([work, fns]) => [work, fns.sort()]))).toEqual(ASKED);
});
