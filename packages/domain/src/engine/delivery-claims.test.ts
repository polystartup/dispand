import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import { match, named, onThis, optional, owner, parse, shape, statement, statementOf, tokens, unwrap, where } from "../test-support-source.ts";

// An answer or a chat message goes to a session at most once per decision, and that decision is
// made at use: it goes through `Engine.sendClaimed`, which claims its row (`claimInputs` sets
// `delivering` where it is still undelivered and unclaimed) and hands the write the row as claimed,
// never one read earlier; it is marked delivered only once the write reached the session. A resume
// claims what its prompt carries the same way. These checks fail on a new path that skips the
// claim, so whoever adds it decides. The sources are read as code (`test-support-source.ts`), not
// lines: what the former line regexes matched is found as runs of tokens, whatever the formatting.

const SRC = join(import.meta.dirname, "..");
const ENGINE = "engine/engine.ts";
const DOT = [".", "?."];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(dir, e.name))
      : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.startsWith("test-support")
        ? [join(dir, e.name)]
        : [],
  );
}
/** The package's sources (under `src`), parsed when first read: only those holding a name a check looks for. */
const SOURCES = files(SRC).map((path) => {
  const text = readFileSync(path, "utf8");
  let source: ts.SourceFile | undefined;
  const file = relative(SRC, path).split(sep).join("/");
  return { file, text, source: () => (source ??= parse(file, text)) };
});

/**
 * `this.adapter.send`, `.answer` and `.steer` in `source`, called or not, as the old regex matched
 * them (`this.adapter.steer ? …`), read through `?.`, `!`, parentheses and `as`. Each run of tokens
 * that regex matched must be one of them; `unclaimed` gets those that aren't.
 */
function adapterWrites(source: ts.SourceFile, unclaimed: string[]): { self: ts.Node; what: string }[] {
  const writes: { self: ts.Node; what: string }[] = [];
  const visit = (node: ts.Node) => {
    const on = ts.isPropertyAccessExpression(node) && onThis(node);
    if (on && on.names.length === 2 && on.names[0] === "adapter" && ["send", "answer", "steer"].includes(on.names[1]!))
      writes.push({ self: on.self, what: on.names.join(".") });
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const [self] of match(source, ["this", DOT, named("adapter"), optional("!"), DOT, named("send", "answer", "steer")]))
    if (!writes.some((w) => w.self === self)) unclaimed.push(where(self!));
  return writes;
}

test("every write of an answer, a chat message or a steer to a session goes through the claim", () => {
  const unclaimed: string[] = [];
  const writes = SOURCES.filter((s) => s.text.includes("adapter")).flatMap(({ file, source }) =>
    adapterWrites(source(), unclaimed).map((w) => ({ file, ...w })),
  );
  expect(unclaimed).toEqual([]);
  const engine = writes.filter((w) => w.file === ENGINE);
  expect(engine.length).toBeGreaterThan(0);
  // Each comes after the claim (exactly the old `this.sendClaimed(`) in its own function: the same
  // declaration, not one of the same name.
  const claims = match(SOURCES.find((s) => s.file === ENGINE)!.source(), ["this", ".", "sendClaimed", "("]).map(([self]) => self!);
  const claimed = (w: (typeof writes)[number]) => {
    const fn = owner(w.self)?.node;
    return !!fn && claims.some((c) => owner(c)?.node === fn && c.getStart() < w.self.getStart());
  };
  expect(engine.filter((w) => !claimed(w)).map((w) => `${owner(w.self)?.path}: this.${w.what} at ${where(w.self)}`)).toEqual([]);
  // Nowhere else in the package does an engine's adapter get them.
  expect([...new Set(writes.filter((w) => w.file !== ENGINE).map((w) => w.file))]).toEqual([]);
});

/** [file, the function it is in (`owner`'s path), its statement, how many such statements, why it writes `delivered_at` or `delivering`]. */
const WRITES: [string, string, string, number, string][] = [
  // The claim, then what its write did: delivered, or given back.
  [
    ENGINE,
    "Engine.claimInputs",
    'return (await this.db.update(table as typeof messages).set({ delivering: token }).where(and(inArray(table.id, ids), isNull(table.deliveredAt), free, still)).returning()) as T["$inferSelect"][];',
    1,
    "the claim, right before the write",
  ],
  [
    ENGINE,
    "Engine.delivered",
    "await this.db.update(table).set({ deliveredAt: new Date(), delivering: null }).where(eq(table.delivering, token));",
    1,
    "only its own claim's rows",
  ],
  [
    ENGINE,
    "Engine.giveBack",
    "await this.db.update(table).set({ delivering: null }).where(and(eq(table.delivering, token), rows ? inArray(table.id, rows.map((r) => r.id)) : undefined));",
    1,
    "only its own claim's rows",
  ],
  // A session found lost: what was written to it since its start proves nothing, and goes again.
  [
    ENGINE,
    "Engine.unconfirm",
    'await tx.update(messages).set({ deliveredAt: null }).where(and(eq(messages.stepRunId, step.id), eq(messages.role, "user"), gte(messages.deliveredAt, since), step.harness?.kind === "codex" ? eq(messages.id, step.codexInputId ?? "") : undefined));',
    1,
    "chat messages",
  ],
  [
    ENGINE,
    "Engine.unconfirm",
    'await tx.update(questions).set({ deliveredAt: null, orphaned: true }).where(and(eq(questions.sessionId, step.sessionId!), eq(questions.status, "answered"), gte(questions.deliveredAt, since)));',
    1,
    "answers, as words",
  ],
  // A single delivery whose write settled just before the loss: its late `delivered` must mark nothing.
  [
    ENGINE,
    "Engine.unconfirm",
    "await tx.update(messages).set({ delivering: null }).where(and(eq(messages.stepRunId, step.id), inArray(messages.delivering, sending)));",
    1,
    "the claims of chat messages under way",
  ],
  [
    ENGINE,
    "Engine.unconfirm",
    "await tx.update(questions).set({ delivering: null }).where(and(eq(questions.sessionId, step.sessionId!), inArray(questions.delivering, sending)));",
    1,
    "the claims of answers under way",
  ],
  [
    ENGINE,
    "Engine.dropSteers",
    'if (dropped.length && step.harness?.kind === "codex") await tx.update(messages).set({ deliveredAt: null }).where(inArray(messages.id, dropped.map((d) => d.id)));',
    1,
    "a steer Codex may not have taken goes again",
  ],
  // Provider activity proves the admitted Codex input (claimed when it was sent) arrived.
  [
    ENGINE,
    "Engine.apply",
    "await tx.update(messages).set({ deliveredAt: new Date() }).where(eq(messages.id, step.codexInputId));",
    1,
    "turn-start: Codex's input",
  ],
  [
    ENGINE,
    "Engine.apply",
    "await tx.update(questions).set({ deliveredAt: new Date() }).where(eq(questions.id, step.codexInputId));",
    1,
    "turn-start: Codex's input",
  ],
  // A reopened chat on a fresh session: what came after the agent's last answer goes to it again.
  [
    "engine/step-lifecycle.ts",
    "reopen",
    'await tx.update(messages).set({ deliveredAt: null }).where(and(eq(messages.stepRunId, step.id), eq(messages.role, "user"), isNotNull(messages.deliveredAt), answer ? sql`${messages.position} > ${answer.position}` : undefined));',
    1,
    "the fresh session hasn't had them",
  ],
];

const delivery = (token: ts.Node) =>
  named("deliveredAt", "delivering")(token) || (ts.isStringLiteral(token) && ["deliveredAt", "delivering"].includes(token.text));

test("delivered_at and delivering are written only by the claim and the listed sites", () => {
  const listed = WRITES.map((entry) => ({ entry, shape: shape(statement(entry[2])) }));
  const unclaimed: string[] = [];
  const unlisted: string[] = [];
  const seen = new Map<(typeof WRITES)[number], number>();
  for (const { file, source } of SOURCES.filter((s) => /deliveredAt|delivering/.test(s.text))) {
    // Every `.set(` call, read through `?.`, `!`, parentheses and `as`; each run of tokens the old
    // regex started with (`.set(`) must be one of them.
    const calls: { call: ts.CallExpression; name: ts.Node }[] = [];
    const visit = (node: ts.Node) => {
      const callee = ts.isCallExpression(node) && unwrap(node.expression);
      if (callee && ts.isPropertyAccessExpression(callee) && callee.name.text.replace(/^#/, "") === "set")
        calls.push({ call: node as ts.CallExpression, name: callee.name });
      ts.forEachChild(node, visit);
    };
    visit(source());
    for (const [dot, name] of match(source(), [DOT, named("set"), optional("!"), optional("?."), "("]))
      if (!calls.some((c) => c.name === name)) unclaimed.push(where(dot!));
    // A write of either field anywhere in its arguments, whatever holds it: `deliveredAt:` as the old
    // regex read it, or a shorthand `{ deliveredAt }`, in a spread (`...(c && { deliveredAt })`) or
    // an object under `as` as well. A read (`cache.set(id, row.deliveredAt)`) writes neither.
    const writes = (arg: ts.Node) =>
      match(arg, [delivery, ":"]).length > 0 || tokens(arg).some((t) => delivery(t) && ts.isShorthandPropertyAssignment(t.parent));
    for (const { call } of calls.filter(({ call }) => call.arguments.some(writes))) {
      const fn = owner(call)?.path;
      const site = shape(statementOf(call));
      const found = listed.find(({ entry: [f, path], shape }) => f === file && path === fn && shape === site);
      if (found) seen.set(found.entry, (seen.get(found.entry) ?? 0) + 1);
      else unlisted.push(`${file}#${fn ?? "?"} (${where(call)}): ${statementOf(call).getText().replace(/\s+/g, " ")}`);
    }
  }
  expect(unclaimed).toEqual([]);
  expect(unlisted).toEqual([]);
  // A listed site that moved or went away is listed no more: the list stays what the code holds.
  expect(WRITES.filter((entry) => seen.get(entry) !== entry[3]).map(([f, fn, code]) => `${f}#${fn}: ${code}`)).toEqual([]);
});
