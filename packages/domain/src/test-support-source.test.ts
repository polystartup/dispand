import ts from "typescript";
import { expect, test } from "vitest";
import { callOf, declares, literal, match, named, optional, owner, parse, shape, statement, statementOf, tokens, unwrap } from "./test-support-source.ts";

const source = (code: string) => parse("snippet.ts", code);
/** What a guard of `spawn(` finds: each such name followed by `(` (after `!` or `?.`), and what it is. */
const spawns = (code: string) =>
  match(source(code), [named("spawn"), optional("!"), optional("?."), "("]).map(([name]) =>
    callOf(name!) ? "call" : declares(name!) ? "declaration" : "neither",
  );

test("a name followed by its parenthesis is found as a call or a declaration, whatever its layout", () => {
  const cases: [string, string[]][] = [
    ["spawn(x)", ["call"]],
    ["this.spawn(x)", ["call"]],
    ["this.#spawn(x)", ["call"]],
    ["a?.spawn(x)", ["call"]],
    ["spawn!(x)", ["call"]],
    ["spawn?.(x)", ["call"]],
    ["new spawn(x)", ["call"]],
    ["spawn\n  // why\n  /* and how */ (x)", ["call"]],
    ["class A { spawn(x) {} }", ["declaration"]],
    ["class A { #spawn(x) {} }", ["declaration"]],
    ["function spawn(x) {}", ["declaration"]],
    ["const f = function spawn(x) {}", ["declaration"]],
    ["const o = { spawn(x) {} }", ["declaration"]],
    // Text in a comment or a string is no code, and a name not followed by its parenthesis no candidate.
    ["// spawn(x)\n/* spawn(x) */ 'spawn(x)'; `spawn(${y})`", []],
    ["const spawn = 1; f(spawn)", []],
    // Followed by its parenthesis but neither a call nor a declaration: a guard fails on it.
    ["class A { get spawn() { return 1; } }", ["neither"]],
  ];
  expect(cases.map(([code]) => [code, spawns(code)])).toEqual(cases);
});

test("an argument is read through parentheses, as, satisfies, ! and spreads, and only a literal is a literal", () => {
  const arg = (code: string) => {
    const call = ((source(code).statements[0] as ts.ExpressionStatement).expression as ts.CallExpression).arguments[0]!;
    return ts.SyntaxKind[unwrap(call).kind];
  };
  expect([arg("f({ a } as O)"), arg("f({ a } satisfies O)"), arg("f(({ a })!)"), arg("f(<O>{ a })"), arg("f(...[a])")]).toEqual([
    "ObjectLiteralExpression",
    "ObjectLiteralExpression",
    "ObjectLiteralExpression",
    "ObjectLiteralExpression",
    "ArrayLiteralExpression",
  ]);
  const lit = (code: string) => literal(((source(code).statements[0] as ts.ExpressionStatement).expression as ts.CallExpression).arguments[0]);
  expect([lit('f("resume")'), lit("f('resume' as const)"), lit("f(`resume`)"), lit("f(launch)"), lit("f(`${a}`)"), lit("f()")]).toEqual([
    "resume",
    "resume",
    "resume",
    undefined,
    undefined,
    undefined,
  ]);
  // A name inside a spread or a wrapped object is among the call's tokens.
  const set = (code: string) =>
    match(source(code), [".", named("set"), "("]).map(([, name]) => tokens(callOf(name!)!).some((t) => t.getText() === "deliveredAt"));
  expect([set("a.set({ ...(c && { deliveredAt }) })"), set("a.set({ deliveredAt: null } as V)"), set("a.set(v)")]).toEqual([[true], [true], [false]]);
});

test("a site's path names the declarations around it, down to its outermost function", () => {
  const at = (code: string) => {
    const file = source(code);
    const here = tokens(file).find((t) => t.getText() === "HERE")!;
    return owner(here)?.path;
  };
  const cases: [string, string | undefined][] = [
    ["class Engine { launch() { const f = () => HERE; } }", "Engine.launch"],
    ["class Engine { #keep(w) { HERE } }", "Engine.#keep"],
    ["class Engine { constructor() { HERE } }", "Engine.constructor"],
    ["class Engine { private done = () => HERE }", "Engine.done"],
    ["class Engine { get refused() { return HERE } }", "Engine.get refused"],
    ["class Engine { set refused(v) { HERE } }", "Engine.set refused"],
    ["class Engine { static dispatch() { HERE } }", "Engine.static dispatch"],
    ["class Engine { a() {} }\nclass Helper { launch() { HERE } }", "Helper.launch"],
    ["export async function keep(work) { function inner() { HERE } }", "keep"],
    ["const NO_TURN = { turnId: null, HERE: null }", "NO_TURN"],
    ["const NO_TURN = { turnId: null, codexInputId: HERE }", "NO_TURN.codexInputId"],
    ["const a = 1, b = { c: HERE }", "b.c"],
    ["export const tools = { create: { run: async () => HERE } }", "tools.create.run"],
    ["export const TOOLS = [{ run: () => 1 }, { run() { HERE } }]", "TOOLS[1].run"],
    ["const t = tool('x', { run: () => HERE })", "t.run"],
    ["const replacement = (former) => ({ resumeAfterSession: HERE })", "replacement"],
    ["interface Row { deliveredAt: HERE }", "Row.deliveredAt"],
    // Outside any declaration: nothing to place it by.
    ["HERE()", undefined],
    ["run(() => HERE)", undefined],
  ];
  expect(cases.map(([code]) => [code, at(code)])).toEqual(cases);
  // A declaration given itself is in its own path; its name is not around it.
  const method = (source("class E { #keep(w) {} }").statements[0] as ts.ClassDeclaration).members[0]!;
  expect([owner(method)?.path, owner((method as ts.MethodDeclaration).name)?.path]).toEqual(["E.#keep", "E"]);
  // The statement a site is in, whole: an `if` without braces keeps its condition.
  const statementText = (code: string) => {
    const [[, name]] = match(source(code), [".", named("set"), "("]) as [[ts.Node, ts.Node]];
    return statementOf(name).getText();
  };
  expect([statementText("function f() { if (a) x.set(1); }"), statementText("function f() { if (a) { x.set(1); } }")]).toEqual([
    "if (a) x.set(1);",
    "x.set(1);",
  ]);
});

/** Code that is the same but for its layout, and code that differs, shape for shape. */
const SAME: [string, string][] = [
  ["a.b( c ,d )", "a.b(c, d)"],
  ["await tx\n  .update(messages)\n  .set({ deliveredAt: null })", "await tx.update(messages).set({ deliveredAt: null })"],
  ["f(/* why */ a) // and how", "f(a)"],
  ["/** doc */ const a = 1", "const a = 1"],
  ["f()", "f();"],
  ["f(a, b,)", "f(a, b)"],
  ["const o = { a: 1, }", "const o = { a: 1 }"],
  ["const l = [1, 2,]", "const l = [1, 2]"],
  ["x = (a && b) || c", "x = a && b || c"],
  ["x = ((f()))", "x = f()"],
  ["f(x => x)", "f((x) => x)"],
  ["new A", "new A()"],
  ["on('error')", 'on("error")'],
  ["on('it\\'s')", 'on("it\'s")'],
  ["'use strict'", '"use strict"'],
  ['function f() { ; "use strict"; }', 'function f() { ("use strict"); }'],
  ["f(1000, 0.5)", "f(1_000, .5)"],
  ["f(1e3, 0x10)", "f(1000, 16)"],
  ['const o = { "a": 1, "b-c": 2 }', 'const o = { a: 1, "b-c": 2 }'],
  ["type T = { a: string, b: number }", "type T = { a: string; b: number; }"],
  ["type T =\n  | 'a'\n  | 'b'", "type T = 'a' | 'b'"],
  ["type T =\n  | 'a'", "type T = 'a'"],
  ["class A { a = 1; ; b() {} }", "class A { a = 1\n b() {} }"],
  ["x = `a${ b }c`", "x = `a${b}c`"],
  ["x = (a?.b)", "x = a?.b"],
  ["if (a) {;}", "if (a) {}"],
  ["type A = { [K in keyof T]: T[K]; }", "type A = { [K in keyof T]: T[K] }"],
];
const DIFFERENT: [string, string][] = [
  ["eq(agents.ownerId, job.ownerId)", "ne(agents.ownerId, job.ownerId)"],
  ["or(a, b)", "or(a, b, c)"],
  ["this.#a.on(x)", "this.a.on(x)"],
  ['socket.on("error ", f)', 'socket.on("error", f)'],
  ["f(1)", "f(2)"],
  ['f("a")', "f(a)"],
  ["x = `a${b}`", "x = `a${c}`"],
  ["a === b", "a !== b"],
  ["x = !a", "x = a"],
  ["x = -1", "x = 1"],
  ["i++", "++i"],
  ["a?.b()", "a.b()"],
  ["a!.b()", "a.b()"],
  ["x = a + b * c", "x = (a + b) * c"],
  ["f(g(x))", "f(g, x)"],
  ["const a = 1", "let a = 1"],
  ["if (x) a(); else b();", "if (x) a();"],
  ["await f()", "f()"],
  ["x = { a: 1 }", "x = { a: 1, ...b }"],
  ["x = (a?.b).c", "x = a?.b.c"],
  ["x = (a?.b)!.c", "x = a?.b!.c"],
  ["x = (a?.b)()", "x = a?.b()"],
  ["x = String.raw`a\\nb`", "x = String.raw`a\nb`"],
  ["on(`error`)", 'on("error")'],
  ["if (a);", "if (a) {}"],
  ['declare module "a" {}', "declare module a {}"],
  ["f([a, , b])", "f([a, b])"],
  ["f([a, ,])", "f([a])"],
  ['("use strict")', '"use strict"'],
  ['"use strict"', '"use\\x20strict"'],
  ["x = (a?.b!).c", "x = a?.b!.c"],
  ['function f() { ; "use strict"; return this; }', 'function f() { "use strict"; return this; }'],
];

test("a shape leaves out formatting, and keeps names, literals, operators and structure", () => {
  const of = (code: string) => shape(statement(code));
  expect(SAME.filter(([a, b]) => of(a) !== of(b))).toEqual([]);
  expect(DIFFERENT.filter(([a, b]) => of(a) === of(b))).toEqual([]);
  expect(() => statement("a(); b()")).toThrow();
  expect(() => statement("a(")).toThrow();
});
