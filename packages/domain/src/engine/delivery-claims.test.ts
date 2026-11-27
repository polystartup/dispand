import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";

// An answer or a chat message goes to a session at most once per decision, and that decision is
// made at use: it goes through `Engine.sendClaimed`, which claims its row (`claimInputs` sets
// `delivering` where it is still undelivered and unclaimed) and hands the write the row as claimed,
// never one read earlier; it is marked delivered only once the write reached the session. A resume
// claims what its prompt carries the same way. These checks fail on a new path that skips the
// claim, so whoever adds it decides.

const SRC = join(import.meta.dirname, "..");
const ENGINE = "engine/engine.ts";

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(dir, e.name))
      : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.startsWith("test-support")
        ? [join(dir, e.name)]
        : [],
  );
}

/** Calls `see` with each node of the package, its file (under `src`) and the function or method it is in: its top-level declaration, or its class's member. */
function walk(see: (node: ts.Node, file: string, fn: string) => void) {
  for (const path of files(SRC)) {
    const source = ts.createSourceFile(relative(SRC, path), readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node, fn: string) => {
      if (ts.isSourceFile(node.parent) || ts.isClassDeclaration(node.parent)) {
        const name = ts.isVariableStatement(node) ? node.declarationList.declarations[0]!.name : (node as ts.NamedDeclaration).name;
        fn = ts.isConstructorDeclaration(node) ? "constructor" : (name?.getText() ?? "");
      }
      see(node, source.fileName, fn);
      ts.forEachChild(node, (child) => visit(child, fn));
    };
    ts.forEachChild(source, (node) => visit(node, ""));
  }
}

/** `name` when `node` is `this.name`. */
const ofThis = (node: ts.Node) => (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword ? node.name.text : undefined);

test("every write of an answer, a chat message or a steer to a session goes through the claim", () => {
  const writes: { file: string; fn: string; at: number; what: string }[] = [];
  const claims: { fn: string; at: number }[] = [];
  walk((node, file, fn) => {
    if (ts.isPropertyAccessExpression(node) && ["send", "answer", "steer"].includes(node.name.text) && ofThis(node.expression) === "adapter") {
      writes.push({ file, fn, at: node.getStart(), what: `this.adapter.${node.name.text}` });
    }
    if (file === ENGINE && ts.isCallExpression(node) && ofThis(node.expression) === "sendClaimed") claims.push({ fn, at: node.getStart() });
  });
  const engine = writes.filter((w) => w.file === ENGINE);
  expect(engine.length).toBeGreaterThan(0);
  // Each comes after the claim in its method.
  expect(engine.filter((w) => !claims.some((c) => c.fn === w.fn && c.at < w.at)).map((w) => `${w.fn}: ${w.what}`)).toEqual([]);
  // Nowhere else in the package does an engine's adapter get them.
  expect([...new Set(writes.filter((w) => w.file !== ENGINE).map((w) => w.file))]).toEqual([]);
});

/** [file, the function it is in, how its statement starts, how many such statements, why it writes `delivered_at` or `delivering`]. */
const WRITES: [string, string, string, number, string][] = [
  // The claim, then what its write did: delivered, or given back.
  [
    "engine/engine.ts",
    "claimInputs",
    "return (await this.db.update(table as typeof messages).set({ delivering: token })",
    1,
    "the claim, right before the write",
  ],
  [
    "engine/engine.ts",
    "delivered",
    "await this.db.update(table).set({ deliveredAt: new Date(), delivering: null }).where(eq(table.delivering, token));",
    1,
    "only its own claim's rows",
  ],
  [
    "engine/engine.ts",
    "giveBack",
    "await this.db.update(table).set({ delivering: null }).where(and(eq(table.delivering, token),",
    1,
    "only its own claim's rows",
  ],
  // A session found lost: what was written to it since its start proves nothing, and goes again.
  ["engine/engine.ts", "unconfirm", "await tx.update(messages).set({ deliveredAt: null })", 1, "chat messages"],
  ["engine/engine.ts", "unconfirm", "await tx.update(questions).set({ deliveredAt: null, orphaned: true })", 1, "answers, as words"],
  // A single delivery whose write settled just before the loss: its late `delivered` must mark nothing.
  [
    "engine/engine.ts",
    "unconfirm",
    "await tx.update(messages).set({ delivering: null }).where(and(eq(messages.stepRunId, step.id), inArray(messages.delivering, sending)));",
    1,
    "the claims of chat messages under way",
  ],
  [
    "engine/engine.ts",
    "unconfirm",
    "await tx.update(questions).set({ delivering: null }).where(and(eq(questions.sessionId, step.sessionId!), inArray(questions.delivering, sending)));",
    1,
    "the claims of answers under way",
  ],
  [
    "engine/engine.ts",
    "dropSteers",
    'if (dropped.length && step.harness?.kind === "codex") await tx.update(messages).set({ deliveredAt: null })',
    1,
    "a steer Codex may not have taken goes again",
  ],
  // Provider activity proves the admitted Codex input (claimed when it was sent) arrived.
  [
    "engine/engine.ts",
    "apply",
    "await tx.update(messages).set({ deliveredAt: new Date() }).where(eq(messages.id, step.codexInputId));",
    1,
    "turn-start: Codex's input",
  ],
  [
    "engine/engine.ts",
    "apply",
    "await tx.update(questions).set({ deliveredAt: new Date() }).where(eq(questions.id, step.codexInputId));",
    1,
    "turn-start: Codex's input",
  ],
  // A reopened chat on a fresh session: what came after the agent's last answer goes to it again.
  ["engine/step-lifecycle.ts", "reopen", "await tx.update(messages).set({ deliveredAt: null })", 1, "the fresh session hasn't had them"],
];

/** `.set({ … })` with `deliveredAt` or `delivering` among its values. */
const writesDelivery = (node: ts.Node) =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  node.expression.name.text === "set" &&
  !!node.arguments[0] &&
  ts.isObjectLiteralExpression(node.arguments[0]) &&
  node.arguments[0].properties.some((p) => ["deliveredAt", "delivering"].includes(p.name?.getText() ?? ""));

/** Code without its layout: no whitespace, no trailing comma. */
const flat = (code: string) => code.replace(/\s+/g, "").replace(/,(?=[)\]}])/g, "");

test("delivered_at and delivering are written only by the claim and the listed sites", () => {
  const unlisted: string[] = [];
  const seen = new Map<(typeof WRITES)[number], number>();
  walk((node, file, fn) => {
    if (!writesDelivery(node)) return;
    // The statement it is in, whole: an `if` without braces keeps its condition.
    const statement = ts.findAncestor(node, (n) => ts.isBlock(n.parent) || ts.isCaseOrDefaultClause(n.parent) || ts.isSourceFile(n.parent))!.getText();
    const entry = WRITES.find(([f, m, start]) => f === file && m === fn && flat(statement).startsWith(flat(start)));
    if (entry) seen.set(entry, (seen.get(entry) ?? 0) + 1);
    else unlisted.push(`${file}#${fn}: ${statement.replace(/\s+/g, " ")}`);
  });
  expect(unlisted).toEqual([]);
  // A listed site that moved or went away is listed no more: the list stays what the code holds.
  expect(WRITES.filter((entry) => seen.get(entry) !== entry[3]).map(([f, fn, start]) => `${f}#${fn}: ${start}`)).toEqual([]);
});
