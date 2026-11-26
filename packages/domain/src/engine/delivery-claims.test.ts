import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";

// An answer or a chat message goes to a session at most once per decision, and that decision is
// made at use: it goes through `Engine.sendClaimed`, which claims its row (`claimInputs` sets
// `delivering` where it is still undelivered and unclaimed) and hands the write the row as claimed,
// never one read earlier; it is marked delivered only once the write reached the session. A resume
// claims what its prompt carries the same way. These checks fail on a new path that skips the
// claim, so whoever adds it decides.

const SRC = join(import.meta.dirname, "..");
const ENGINE = join(import.meta.dirname, "engine.ts");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.startsWith("test-support") ? [join(dir, e.name)] : []));
}

test("every write of an answer, a chat message or a steer to a session goes through the claim", () => {
  const source = readFileSync(ENGINE, "utf8");
  // The engine's methods, by where each one's declaration starts.
  const methods = [...source.matchAll(/^ {2}(?:private |async |static )*(\w+)(?:<[^>]*>)?\(/gm)].map((m) => ({ name: m[1]!, at: m.index }));
  const writes = [...source.matchAll(/this\.adapter\.(?:send|answer|steer)\b/g)];
  expect(writes.length).toBeGreaterThan(0);
  const unclaimed = writes.flatMap((w) => {
    const method = methods.filter((m) => m.at < w.index).at(-1)!;
    const before = source.slice(method.at, w.index);
    return /this\.sendClaimed\(/.test(before) ? [] : [`${method.name}: ${w[0]}`];
  });
  expect(unclaimed).toEqual([]);
  // Nowhere else in the package does an engine's adapter get them.
  const elsewhere = files(SRC).filter((path) => path !== ENGINE && /this\.adapter\.(?:send|answer|steer)\b/.test(readFileSync(path, "utf8")));
  expect(elsewhere.map((path) => relative(SRC, path))).toEqual([]);
});

/** [file, text the line starts with, how many such lines, why it writes `delivered_at` or `delivering`]. */
const WRITES: [string, string, number, string][] = [
  // The claim, then what its write did: delivered, or given back.
  ["engine/engine.ts", ".set({ delivering: token })", 1, "claimInputs: the claim, right before the write"],
  ["engine/engine.ts", "await this.db.update(table).set({ deliveredAt: new Date(), delivering: null }).where(eq(table.delivering, token));", 1, "delivered: only its own claim's rows"],
  ["engine/engine.ts", "await this.db.update(table).set({ delivering: null }).where(and(eq(table.delivering, token),", 1, "giveBack: only its own claim's rows"],
  // A session found lost: what was written to it since its start proves nothing, and goes again.
  ["engine/engine.ts", ".set({ deliveredAt: null })", 1, "unconfirm: chat messages"],
  ["engine/engine.ts", ".set({ deliveredAt: null, orphaned: true })", 1, "unconfirm: answers, as words"],
  ["engine/engine.ts", "if (dropped.length && step.harness?.kind === \"codex\") await tx.update(messages).set({ deliveredAt: null })", 1, "dropSteers: a steer Codex may not have taken goes again"],
  // Provider activity proves the admitted Codex input (claimed when it was sent) arrived.
  ["engine/engine.ts", "await tx.update(messages).set({ deliveredAt: new Date() }).where(eq(messages.id, step.codexInputId));", 1, "turn-start: Codex's input"],
  ["engine/engine.ts", "await tx.update(questions).set({ deliveredAt: new Date() }).where(eq(questions.id, step.codexInputId));", 1, "turn-start: Codex's input"],
  // A reopened chat on a fresh session: what came after the agent's last answer goes to it again.
  ["engine/step-lifecycle.ts", "await tx.update(messages).set({ deliveredAt: null })", 1, "reopen: the fresh session hasn't had them"],
];

test("delivered_at and delivering are written only by the claim and the listed sites", () => {
  const unlisted: string[] = [];
  const seen = new Map<(typeof WRITES)[number], number>();
  for (const path of files(SRC)) {
    const file = relative(SRC, path);
    for (const [i, line] of readFileSync(path, "utf8").split("\n").entries()) {
      if (!/\.set\(\{[^}]*\b(?:deliveredAt|delivering):/.test(line)) continue;
      const entry = WRITES.find(([f, text]) => f === file && line.trim().startsWith(text));
      if (entry) seen.set(entry, (seen.get(entry) ?? 0) + 1);
      else unlisted.push(`${file}:${i + 1}: ${line.trim()}`);
    }
  }
  expect(unlisted).toEqual([]);
  // A listed site that moved or went away is listed no more: the list stays what the code holds.
  expect(WRITES.filter((entry) => seen.get(entry) !== entry[2]).map(([f, text]) => `${f}: ${text}`)).toEqual([]);
});
