import { readFileSync } from "node:fs";
import { join } from "node:path";
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
const SITE = /\bkeep\(|deferred\.push\(|\bsetTimeout\(|\bsetInterval\(|\.subscribe\(|\.on\(|\.once\(/;

type Kind = "inherits" | "re-scoped" | "detached" | "no database work";
/** [module, text the line holds, how many such lines, why its scope is right]. */
const ALLOWED: [string, string, number, Kind][] = [
  ["engine/engine.ts", "private keep(work: Promise<void>): void {", 1, "no database work"],
  ["engine/engine.ts", "this.keep(sent);", 1, "inherits"],
  // A session's delivery runs in its caller's scope, which its turn carries; one that waited for a
  // reconcile sets its run's scope itself (`inSession`).
  ["engine/engine.ts", "this.keep(turn.finally(() => {", 1, "inherits"],
  ["engine/engine.ts", "this.keep(call);", 1, "inherits"],
  ["engine/engine.ts", "this.keep(failed);", 1, "inherits"],
  ["engine/engine.ts", "this.keep(\n", 1, "inherits"],
  ["engine/engine.ts", "this.keep(inRunScope(this.db, e.runId, () => this.handOver(e.stepId))", 1, "re-scoped"],
  ["engine/engine.ts", "this.keep(started.catch(", 1, "re-scoped"],
  // Its read sets SYSTEM itself; what it then publishes does no database work.
  ["engine/engine.ts", "this.keep(told);", 1, "re-scoped"],
  // `run` is `detached`: each tick then sets SYSTEM and splits its passes by workspace.
  ["engine/scheduler.ts", "this.timer = setInterval(run, SCHEDULER_TICK_MS);", 1, "detached"],
  ["runners/hub.ts", 'socket.on("error", () => socket.destroy());', 1, "no database work"],
  ["runners/hub.ts", 'const timer = setTimeout(() => settle(() => reject(new RunnerRequestFailed("timed out"))), timeoutMs);', 1, "no database work"],
  ["runners/hub.ts", 'ws.on("error", detached(', 1, "detached"],
  ["runners/hub.ts", 'ws.on("close", detached(', 1, "detached"],
  ["runners/hub.ts", 'ws.on("message", detached(', 1, "detached"],
  ["runners/hub.ts", "setTimeout(() => {\n", 1, "no database work"],
  ["push/sender.ts", "this.engine.questionChanges.subscribe(ANY_WORKSPACE,", 1, "no database work"],
  ["push/sender.ts", "this.timer = setTimeout(detached(() => {", 1, "detached"],
];

test("every launch site in the engine, scheduler, hub, cloud runner and push sender is listed with why its scope is right", () => {
  const unlisted: string[] = [];
  const seen = new Map<(typeof ALLOWED)[number], number>();
  for (const module of MODULES) {
    const lines = readFileSync(join(import.meta.dirname, "..", module), "utf8").split("\n");
    for (const [i, line] of lines.entries()) {
      if (!SITE.test(line) || /^\s*(\/\/|\*)/.test(line)) continue;
      const entry = ALLOWED.find(([m, text]) => m === module && `${line.trim()}\n`.includes(text));
      if (entry) seen.set(entry, (seen.get(entry) ?? 0) + 1);
      else unlisted.push(`${module}:${i + 1}: ${line.trim()}`);
    }
  }
  expect(unlisted).toEqual([]);
  // A listed site that moved or went away is listed no more: the list stays what the code holds.
  expect(ALLOWED.filter((entry) => seen.get(entry) !== entry[2]).map(([m, text]) => `${m}: ${text}`)).toEqual([]);
});

