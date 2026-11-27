import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import { called, listed, match, named, optional, owner, parse, site, stringSites, where, type Step } from "../test-support-source.ts";

// Work that outlives its caller (kept promises, deferred retries, timers, subscriptions, event
// listeners) runs in the scope it was launched in, which AsyncLocalStorage carries along. Each such
// site in these long-lived modules is listed here and says why its scope is right:
// - inherits: work of the caller's own run, started synchronously, or the startup's scope;
// - re-scoped: it sets its run's scope itself (`inRunScope`);
// - detached: it runs with no scope (`detached`), whoever fired it, and sets its own;
// - no database work.
// A new site fails until it is listed, so whoever adds it decides. The sources are read as code
// (`test-support-source.ts`), not lines: what the former line regex matched is found as runs of
// tokens, whatever the formatting (and in a string's text, as it read that too), each is placed in
// the tree (a call, or a function it declares, in its function), and its statement is compared with
// its entry's by shape.

const MODULES = ["engine/engine.ts", "engine/scheduler.ts", "runners/hub.ts", "cloud/runner.ts", "push/sender.ts"];

/** A name as the former regex's `\b` read it: an identifier (or `#private`) ending so, after a non-word character (`$keep`, `#keep`). */
const ending = (re: RegExp) => (token: ts.Node) => (ts.isIdentifier(token) || ts.isPrivateIdentifier(token)) && re.test(token.text);
/** What the former regex's `\.` read before a name: any token ending in a dot (`.`, `?.`, a spread's `...`). */
const DOT = (token: ts.Node) => token.getText().endsWith(".");
const CALL: Step[] = [optional("!"), optional("?."), "("];
/** The former line regex, read as it was in strings. */
const SITE = /\bkeep\(|deferred\.push\(|\bsetTimeout\(|\bsetInterval\(|\.subscribe\(|\.on\(|\.once\(/;
/** `SITE` in code, as runs of tokens ending in the name's `(`. */
const PATTERNS: Step[][] = [
  [ending(/\b(?:keep|setTimeout|setInterval)$/), ...CALL],
  [ending(/deferred$/), optional("!"), DOT, named("push"), ...CALL],
  [DOT, named("subscribe", "on", "once"), ...CALL],
];

type Kind = "inherits" | "re-scoped" | "detached" | "no database work";
/**
 * [module, the function it is in (`owner`'s path), its statement (`listed`: a method written in
 * `class _ { … }`, by its signature), how many such sites, why its scope is right, and the call
 * alone when the statement holds different launches (each is then listed with its own)].
 */
const ALLOWED: [string, string, string, number, Kind, string?][] = [
  ["engine/engine.ts", "Engine.keep", "class _ { private keep(work: Promise<void>): void {} }", 1, "no database work"],
  ["engine/engine.ts", "Engine.dispatch", "this.keep(sent);", 1, "inherits"],
  // A session's delivery runs in its caller's scope, which its turn carries; one that waited for a
  // reconcile sets its run's scope itself (`inSession`).
  [
    "engine/engine.ts",
    "Engine.inSession",
    "this.keep(turn.finally(() => { if (this.lanes.get(sessionId) === turn) this.lanes.delete(sessionId); }));",
    1,
    "inherits",
  ],
  ["engine/engine.ts", "Engine.startTool", "this.keep(call);", 1, "inherits"],
  ["engine/engine.ts", "Engine.dispatch", "this.keep(failed);", 1, "inherits"],
  [
    "engine/engine.ts",
    "Engine.stopSession",
    'this.keep(this.adapter.stop(sessionId, source).then(() => undefined).catch((err: unknown) => logError("session stop failed", err, { ref: sessionId })));',
    1,
    "inherits",
  ],
  // The first branch: a step handed a slot.
  [
    "engine/engine.ts",
    "Engine.publish",
    'if (e.type === "slot") this.keep(inRunScope(this.db, e.runId, () => this.handOver(e.stepId)).catch((err: unknown) => logError("slot hand-over failed", err, { ref: e.stepId }))); ' +
      'else if (e.type === "job") { const started = this.announceCheckpoints().then(() => inRunScope(this.db, e.runId, () => this.continueRun(e.runId))); ' +
      'this.keep(started.catch((err: unknown) => logError("consulted Job start failed", err, { ref: e.runId }))); } ' +
      'else if (e.type === "end") this.endSessions(e.steps); else this.events.publish(runOf(e), e);',
    1,
    "re-scoped",
  ],
  // A hand-over retried once the start claim it met settles (`handOverLater`).
  [
    "engine/engine.ts",
    "Engine.handOverLater",
    'this.keep(settled.then(() => inRunScope(this.db, step.runId, () => this.handOver(step.id))).catch((err: unknown) => logError("slot hand-over failed", err, { ref: step.id })));',
    1,
    "re-scoped",
  ],
  [
    "engine/engine.ts",
    "Engine.publish",
    'this.keep(started.catch((err: unknown) => logError("consulted Job start failed", err, { ref: e.runId })));',
    1,
    "re-scoped",
  ],
  // Its read sets SYSTEM itself; what it then publishes does no database work.
  ["engine/engine.ts", "Engine.publish", "this.keep(told);", 1, "re-scoped"],
  // `run` is `detached`: each tick then sets SYSTEM and splits its passes by workspace.
  ["engine/scheduler.ts", "Scheduler.start", "this.timer = setInterval(run, SCHEDULER_TICK_MS);", 1, "detached"],
  ["runners/hub.ts", "RunnerHub.handleUpgrade", 'socket.on("error", () => socket.destroy());', 1, "no database work"],
  [
    "runners/hub.ts",
    "RunnerHub.ask",
    'const timer = setTimeout(() => settle(() => reject(new RunnerRequestFailed("timed out"))), timeoutMs);',
    1,
    "no database work",
  ],
  ["runners/hub.ts", "RunnerHub.attach", 'ws.on("error", detached(() => this.retire(conn)));', 1, "detached"],
  ["runners/hub.ts", "RunnerHub.attach", 'ws.on("close", detached(() => this.retire(conn)));', 1, "detached"],
  [
    "runners/hub.ts",
    "RunnerHub.attach",
    'ws.on("message", detached((data: WebSocket.RawData) => { if (conn.retired) return; const raw = (data as Buffer).toString(); const bytes = Buffer.byteLength(raw); ' +
      'if (runnerState.pending.length >= MAX_PENDING_MESSAGES || runnerState.pendingBytes + bytes > MAX_PENDING_BYTES) { return this.retire(conn, 1008, "too many pending messages"); } ' +
      "runnerState.pending.push({ conn, raw, bytes }); runnerState.pendingBytes += bytes; " +
      'this.drain(runnerState).catch((err: unknown) => logError("runner inbox failed", err, { runnerId: runner.id })); }));',
    1,
    "detached",
  ],
  [
    "runners/hub.ts",
    "RunnerHub.retire",
    "setTimeout(() => { if (conn.ws.readyState !== WebSocket.CLOSED) conn.ws.terminate(); }, 1000).unref();",
    1,
    "no database work",
  ],
  [
    "push/sender.ts",
    "PushSender.start",
    "const changes = this.engine.questionChanges.subscribe(ANY_WORKSPACE, { signal: this.stopping.signal });",
    1,
    "no database work",
  ],
  [
    "push/sender.ts",
    "PushSender.wake",
    "this.timer = setTimeout(detached(() => { this.timer = undefined; void inScope(SYSTEM, () => this.flush()); }), delay);",
    1,
    "detached",
  ],
];

test("every launch site in the engine, scheduler, hub, cloud runner and push sender is listed with why its scope is right", () => {
  const entries = ALLOWED.map((entry) => ({ entry, code: listed(entry[2]), call: entry[5] && called(entry[5]) }));
  const unplaced: string[] = [];
  const unlisted: string[] = [];
  const seen = new Map<(typeof ALLOWED)[number], string[]>();
  for (const module of MODULES) {
    const source = parse(module, readFileSync(join(import.meta.dirname, "..", module), "utf8"));
    const runs = PATTERNS.flatMap((pattern) => match(source, pattern)).map((run) => {
      const name = run.filter((t) => ts.isIdentifier(t) || ts.isPrivateIdentifier(t)).at(-1)!;
      return { name, found: site(name, run.at(-1)!) };
    });
    for (const { name, found } of [...runs, ...stringSites(source, SITE).map((found) => ({ name: found.node, found }))]) {
      const path = found && owner(found.node)?.path;
      // Neither a call nor a function declared, or outside any declaration: nothing to place it by.
      if (!found || !path) {
        unplaced.push(where(name));
        continue;
      }
      const listing = entries.find(({ entry: [m, fn], code, call }) => m === module && fn === path && code === found.code && (!call || call === found.call));
      if (listing) seen.set(listing.entry, [...(seen.get(listing.entry) ?? []), found.call]);
      else unlisted.push(`${module}#${path} (${where(found.node)}): ${found.at.getText().replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }
  expect(unplaced, "a match of the former regex that is neither a call, a declaration nor a string in a function").toEqual([]);
  expect(unlisted).toEqual([]);
  // A listed site that moved or went away is listed no more: the list stays what the code holds.
  expect(ALLOWED.filter((entry) => seen.get(entry)?.length !== entry[3]).map(([m, fn, code]) => `${m}#${fn}: ${code}`)).toEqual([]);
  // An entry without its call stands for one call (or copies of it): a statement holding different launches lists each with its call.
  expect(
    ALLOWED.filter((entry) => !entry[5] && new Set(seen.get(entry)).size > 1).map(([m, fn, code]) => `${m}#${fn}: ${code}`),
    "a statement holding different launches: list each with its call",
  ).toEqual([]);
});

test("the finder reads each shape the former regex read", () => {
  const shapes = [
    "a.on(x)",
    "a?.once(x)",
    "f(...on(a))",
    "({ ...once(b) })",
    "[...subscribe(c)]",
    "1..on(x)",
    "this.#deferred.push(x)",
    "$keep(x)",
    "this.#keep(x)",
    "class A { #keep(w) {} }",
    "setInterval(f)",
    'run("x.on(y)")',
    "`a.on(${b})`",
    "/a.on(b)/g",
  ];
  const found = (code: string) => {
    const source = parse("x.ts", code);
    return PATTERNS.flatMap((pattern) => match(source, pattern)).length + stringSites(source, SITE).length;
  };
  expect(shapes.filter((code) => !SITE.test(code) || !found(code))).toEqual([]);
});
