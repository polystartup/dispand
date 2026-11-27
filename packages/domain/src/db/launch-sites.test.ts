import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";

// Work that outlives its caller (kept promises, deferred retries, timers, subscriptions, event
// listeners) runs in the scope it was launched in, which AsyncLocalStorage carries along. Each such
// site in these long-lived modules is listed here and says why its scope is right:
// - inherits: work of the caller's own run, started synchronously, or the startup's scope;
// - re-scoped: it sets its run's scope itself (`inRunScope`);
// - detached: it runs with no scope (`detached`), whoever fired it, and sets its own;
// - no database work.
// A new site fails until it is listed, so whoever adds it decides.

const MODULES = ["engine/engine.ts", "engine/scheduler.ts", "runners/hub.ts", "cloud/runner.ts", "push/sender.ts"];

type Kind = "inherits" | "re-scoped" | "detached" | "no database work";
/** [module, the class member it is in, how its code starts, how many such sites, why its scope is right]. */
const ALLOWED: [string, string, string, number, Kind][] = [
  ["engine/engine.ts", "keep", "private keep(work: Promise<void>): void {", 1, "no database work"],
  ["engine/engine.ts", "dispatch", "this.keep(sent)", 1, "inherits"],
  // A session's delivery runs in its caller's scope, which its turn carries; one that waited for a
  // reconcile sets its run's scope itself (`inSession`).
  ["engine/engine.ts", "inSession", "this.keep(turn.finally(() => {", 1, "inherits"],
  ["engine/engine.ts", "startTool", "this.keep(call)", 1, "inherits"],
  ["engine/engine.ts", "dispatch", "this.keep(failed)", 1, "inherits"],
  ["engine/engine.ts", "stopSession", "this.keep(this.adapter.stop(sessionId, source)", 1, "inherits"],
  ["engine/engine.ts", "publish", "this.keep(inRunScope(this.db, e.runId, () => this.handOver(e.stepId))", 1, "re-scoped"],
  // A hand-over retried once the start claim it met settles (`handOverLater`).
  ["engine/engine.ts", "handOverLater", "this.keep(settled.then(() => inRunScope(this.db, step.runId, () => this.handOver(step.id)))", 1, "re-scoped"],
  ["engine/engine.ts", "publish", "this.keep(started.catch(", 1, "re-scoped"],
  // Its read sets SYSTEM itself; what it then publishes does no database work.
  ["engine/engine.ts", "publish", "this.keep(told)", 1, "re-scoped"],
  // `run` is `detached`: each tick then sets SYSTEM and splits its passes by workspace.
  ["engine/scheduler.ts", "start", "setInterval(run, SCHEDULER_TICK_MS)", 1, "detached"],
  ["runners/hub.ts", "handleUpgrade", 'socket.on("error", () => socket.destroy())', 1, "no database work"],
  ["runners/hub.ts", "ask", 'setTimeout(() => settle(() => reject(new RunnerRequestFailed("timed out"))), timeoutMs)', 1, "no database work"],
  ["runners/hub.ts", "attach", 'ws.on("error", detached(', 1, "detached"],
  ["runners/hub.ts", "attach", 'ws.on("close", detached(', 1, "detached"],
  ["runners/hub.ts", "attach", 'ws.on("message", detached(', 1, "detached"],
  ["runners/hub.ts", "retire", "setTimeout(() => { if (conn.ws.readyState !== WebSocket.CLOSED) conn.ws.terminate();", 1, "no database work"],
  ["push/sender.ts", "start", "this.engine.questionChanges.subscribe(ANY_WORKSPACE, { signal: this.stopping.signal })", 1, "no database work"],
  ["push/sender.ts", "wake", "setTimeout(detached(() => {", 1, "detached"],
];

/** Code with its layout taken out (whitespace, trailing commas), so a reformatted site still matches its entry. */
const flat = (code: string) => code.replace(/\s+/g, "").replace(/,(?=[)\]}])/g, "");
const TIMERS = ["keep", "setTimeout", "setInterval"];

/** Launches work: `keep(`, `setTimeout(` or `setInterval(` (or a method of that name), `.subscribe(`, `.on(`, `.once(`, `deferred.push(`. */
function launches(node: ts.Node): boolean {
  if (ts.isMethodDeclaration(node)) return TIMERS.includes(node.name.getText());
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return TIMERS.includes(callee.text);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const name = callee.name.text;
  return [...TIMERS, "subscribe", "on", "once"].includes(name) || (name === "push" && /deferred$/.test(callee.expression.getText()));
}

/** The class member (or top-level declaration) a node is in. */
function member(node: ts.Node): string {
  while (!ts.isClassLike(node.parent) && !ts.isSourceFile(node.parent)) node = node.parent;
  if (ts.isVariableStatement(node)) node = node.declarationList.declarations[0]!;
  return ts.isConstructorDeclaration(node) ? "constructor" : (ts.getNameOfDeclaration(node as ts.Declaration)?.getText() ?? "(top level)");
}

test("every launch site in the engine, scheduler, hub, cloud runner and push sender is listed with why its scope is right", () => {
  const unlisted: string[] = [];
  const seen = new Map<(typeof ALLOWED)[number], number>();
  for (const module of MODULES) {
    const file = ts.createSourceFile(module, readFileSync(join(import.meta.dirname, "..", module), "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (launches(node)) {
        const [code, at] = [node.getText(), member(node)];
        const entry = ALLOWED.find(([m, inside, start]) => m === module && inside === at && flat(code).startsWith(flat(start)));
        if (entry) seen.set(entry, (seen.get(entry) ?? 0) + 1);
        else unlisted.push(`${module}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${at}: ${code.replace(/\s+/g, " ").slice(0, 120)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  expect(unlisted).toEqual([]);
  // A listed site that moved or went away is listed no more: the list stays what the code holds.
  expect(ALLOWED.filter((entry) => seen.get(entry) !== entry[3]).map(([m, at, start]) => `${m} ${at}: ${start}`)).toEqual([]);
});
