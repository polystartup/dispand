import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";

// Every call from the engine to a harness (`this.adapter`), to the cloud runner (`this.cloud`) or
// to a Tool step's tool (`this.toolSteps`), and every write of a session's delivery state, sits in
// a function listed here, which says why it may run where it runs. A new one fails until it is
// listed, so whoever adds it decides whether it asks the gate (`PlaceGate`).

const DIR = import.meta.dirname;
// The adapter the engine calls through is no caller of its own.
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "routing-adapter.ts");
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

/** `file#function`: its kind, and why. */
const CLASSIFIED: Record<string, [Kind, string]> = {
  "engine.ts#narrowSessions": [
    "forwarded",
    "narrowing goes out through the hub's send (the CLI adapter), which a process sharing the database wraps to reach the runner's holder, or through the cloud runner's entries",
  ],
  "engine.ts#interruptChat": ["forwarded", "an interrupt's waiter lives with the holder: the entry runs there"],
  "engine.ts#stopSession": [
    "forwarded",
    "a stop goes out through the hub's send (the CLI adapter), wrapped as narrowing is, or through the cloud runner's entries",
  ],
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

type Node = { file: string; fn: string; node: ts.Node };
type Site = Node & { what: string };

/** `name` when `node` is `this.name`. */
const ofThis = (node: ts.Node) => (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword ? node.name.text : undefined);
/** `name` when `node` calls `this.name(`. */
const callOf = (node: ts.Node) => (ts.isCallExpression(node) ? ofThis(node.expression) : undefined);

/** Every node of `file`, with the function or method it is in: its top-level declaration, or its class's member. */
function walk(file: string): Node[] {
  const nodes: Node[] = [];
  const visit = (node: ts.Node, fn: string) => {
    if (ts.isSourceFile(node.parent) || ts.isClassDeclaration(node.parent)) {
      const name = ts.isVariableStatement(node) ? node.declarationList.declarations[0]!.name : (node as ts.NamedDeclaration).name;
      fn = ts.isConstructorDeclaration(node) ? "constructor" : (name?.getText() ?? "");
    }
    nodes.push({ file, fn, node });
    ts.forEachChild(node, (child) => visit(child, fn));
  };
  ts.forEachChild(ts.createSourceFile(file, readFileSync(join(DIR, file), "utf8"), ts.ScriptTarget.Latest, true), (node) => visit(node, ""));
  return nodes;
}

function sites(): { all: Site[]; nodes: Node[] } {
  const nodes = FILES.flatMap(walk);
  const all = nodes.flatMap(({ file, fn, node }): Site[] => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const on = ofThis(node.expression.expression);
      if (on && CALLEE.includes(on)) return [{ file, fn, node, what: `${on}.${node.expression.name.text}` }];
    }
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && DELIVERY.includes(node.name.getText()))
      return [{ file, fn, node, what: node.name.getText() }];
    return [];
  });
  return { all, nodes };
}

test("every adapter and cloud runner call site is classified", () => {
  const { all, nodes } = sites();
  const key = (s: { file: string; fn: string }) => `${s.file}#${s.fn}`;
  const holders = Object.entries(CLASSIFIED)
    .filter(([, [kind]]) => kind === "holder")
    .map(([k]) => k);
  // Calls of a holder from the engine itself: `this.name(`.
  const holderCalls = nodes.flatMap((n) => (holders.includes(`${n.file}#${callOf(n.node)}`) ? [{ ...n, what: `calls ${callOf(n.node)}` }] : []));
  // Every function with a site, or calling a holder, is listed; nothing listed has neither.
  const found = new Set([...all, ...holderCalls].map(key));
  expect([...found].filter((k) => !CLASSIFIED[k]).sort()).toEqual([]);
  expect(
    Object.keys(CLASSIFIED)
      .filter((k) => !found.has(k))
      .sort(),
  ).toEqual([]);
  // A gated function asks before each site and each call of a holder, or makes it in a gated call's arguments.
  const gated = Object.entries(CLASSIFIED)
    .filter(([, [kind]]) => kind === "gated")
    .map(([k]) => k);
  const gates = nodes.filter((n) => ofThis(n.node) === "gate");
  for (const site of [...all, ...holderCalls].filter((s) => gated.includes(key(s)))) {
    const asked = gates.some((g) => key(g) === key(site) && g.node.getStart() < site.node.getStart());
    const inside = !!ts.findAncestor(site.node.parent, (up) => gated.includes(`${site.file}#${callOf(up)}`));
    expect(asked || inside, `${key(site)} asks the gate before ${site.what}`).toBe(true);
  }
});

test("each kind of work is asked where it is listed", () => {
  const asked: Record<string, string[]> = {};
  for (const { fn, node } of walk("engine.ts")) {
    if (!ts.isCallExpression(node) || callOf(node) !== "admits") continue;
    // `table === questions ? "answer" : "message"` asks either; any other work not given as a literal fails by its text.
    const work = node.arguments[0]!;
    const either = ts.isConditionalExpression(work) && work.condition.getText().replace(/\s+/g, " ") === "table === questions";
    for (const w of either ? [work.whenTrue, work.whenFalse] : [work]) (asked[ts.isStringLiteral(w) ? w.text : w.getText()] ??= []).push(fn);
  }
  expect(Object.fromEntries(Object.entries(asked).map(([work, fns]) => [work, [...new Set(fns)].sort()]))).toEqual(ASKED);
});
