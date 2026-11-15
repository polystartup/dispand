import { ORPCError } from "@orpc/server";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import { validationKey } from "../rpc/context.ts";
import en from "./en.json";
import fr from "./fr.json";
import { external, isMessageKey, message, reasonOf } from "./index.ts";

/** Every key of a resource, plural forms included, as dotted paths. */
const keys = (value: unknown, prefix = ""): string[] =>
  typeof value === "object" && value ? Object.entries(value).flatMap(([k, v]) => keys(v, `${prefix}${k}.`)) : [prefix.slice(0, -1)];

test("French has every English server message, and nothing more", () => {
  expect(keys(fr).sort()).toEqual(keys(en).sort());
});

test("a message carries its key and values, and its English sentence for agents and logs", () => {
  expect(message("questions.answer.missing", { question: "Who?" })).toEqual({ message: "Answer “Who?”.", data: { key: "questions.answer.missing", values: { question: "Who?" } } });
  expect(message("questions.notFound")).toEqual({ message: "This question doesn't exist.", data: { key: "questions.notFound" } });
  expect(message("plugins.marketplace.removeFirst", { plugins: ["law", "tax"] }).message).toBe("Remove its plugins first: law and tax.");
  expect(reasonOf(new ORPCError("CONFLICT", message("plugins.notFound")))).toEqual({ key: "plugins.notFound" });
  expect(reasonOf(new ORPCError("CONFLICT", { message: "Plain words" }))).toEqual({ text: "Plain words" });
  expect(external("The server said <no>")).toEqual({ message: "The server said <no>", data: { external: true } });
  expect([isMessageKey("validation.too_small.string"), isMessageKey("questions"), isMessageKey("The chat is over")]).toEqual([true, false, false]);
});

test("a rejected input's issue becomes a validation message, its plural chosen by the limit", () => {
  const short = (minimum: number) => {
    const { key, values } = validationKey({ code: "too_small", origin: "string", minimum, path: ["answer", "message"] });
    return message(key, values).message;
  };
  expect([short(1), short(3)]).toEqual(["“answer.message” needs at least 1 character.", "“answer.message” needs at least 3 characters."]);
  expect(validationKey({ code: "too_big", origin: "number", maximum: 5, path: [] })).toEqual({ key: "validation.too_big.number", values: { field: "input", maximum: 5 } });
  expect(validationKey({ code: "something_new", path: ["a", 0] })).toEqual({ key: "validation.custom", values: { field: "a.0" } });
});

// Errors whose text may reach a person and isn't yet a `message()` key or text marked as external,
// per file: each Task 4 pull request keys an area and takes its files out. Exact counts, so a new
// unkeyed error fails, and so does a keyed one left counted.
const UNKEYED: Record<string, number> = {
  "agents/procedures.ts": 20,
  "assistant/commands.ts": 3,
  "assistant/invoke.ts": 4,
  "audit/procedures.ts": 1,
  // The engine's EngineErrors, all but the Inbox answer's (keyed with the questions area).
  "engine/engine.ts": 18,
  "harnesses/procedures.ts": 6,
  "jobs/procedures.ts": 7,
  "memory/procedures.ts": 4,
  "pages/procedures.ts": 13,
  "rpc/context.ts": 1,
  "rpc/router.ts": 3,
  "runners/procedures.ts": 10,
  "runners/workspace-plugin.ts": 10,
  "skills/procedures.ts": 13,
  "tools/procedures.ts": 18,
  "triggers/procedures.ts": 14,
  "workflows/procedures.ts": 15,
};

const src = join(import.meta.dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [join(dir, e.name)] : []));

/** A key or a text given whole: not a template, not a concatenation. */
const whole = (node: ts.Expression | undefined) => !!node && !ts.isTemplateExpression(node) && !ts.isBinaryExpression(node);
const callTo = (node: ts.Expression, name: string): node is ts.CallExpression => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;

/** Whether an error's options are a single `message()` key, text marked as external, or a keyed engine error passed on (`passOn(err)`, typed `EngineError`). */
function keyed(options: ts.Expression | undefined): boolean {
  if (!options) return false;
  if (callTo(options, "message") || callTo(options, "external")) return whole(options.arguments[0]);
  return callTo(options, "passOn") && options.arguments.length === 1 && ts.isIdentifier(options.arguments[0]!);
}

/** Every `new ORPCError(` and `new EngineError(` of a file whose options aren't keyed. */
function unkeyed(path: string): number {
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  let n = 0;
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && ["ORPCError", "EngineError"].includes(node.expression.text) && !keyed(node.arguments?.[1])) n++;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return n;
}

test("every error of the domain says a message key or external text, except those still listed", () => {
  const found = Object.fromEntries(files(src).flatMap((path) => (unkeyed(path) ? [[relative(src, path), unkeyed(path)]] : [])));
  expect(found).toEqual(UNKEYED);
});

test("the walk judges the message's form, not where it comes from", () => {
  const judge = (code: string) => {
    const file = ts.createSourceFile("x.ts", code, ts.ScriptTarget.Latest, true);
    const expr = (file.statements[0] as ts.ExpressionStatement).expression as ts.NewExpression;
    return keyed(expr.arguments?.[1]);
  };
  expect(judge('new ORPCError("BAD_REQUEST", message("questions.notFound"))')).toBe(true);
  expect(judge('new ORPCError("BAD_REQUEST", message("questions.answer.missing", { question }))')).toBe(true);
  expect(judge('new ORPCError("BAD_REQUEST", message(key, values))')).toBe(true);
  expect(judge('new ORPCError("BAD_REQUEST", external(serverText))')).toBe(true);
  expect(judge('new ORPCError("CONFLICT", passOn(err))')).toBe(true);
  expect(judge('new ORPCError("CONFLICT", { message: err.message, data: err.data })')).toBe(false);
  expect(judge('new ORPCError("NOT_FOUND")')).toBe(false);
  expect(judge('new ORPCError("BAD_REQUEST", { message: "Plain text" })')).toBe(false);
  expect(judge('new ORPCError("BAD_REQUEST", { message: `Answer ${q}` })')).toBe(false);
  expect(judge('new ORPCError("BAD_REQUEST", { message: "a" + b })')).toBe(false);
  expect(judge('new ORPCError("BAD_REQUEST", { message })')).toBe(false);
  expect(judge('new ORPCError("BAD_REQUEST", options)')).toBe(false);
  expect(judge('new ORPCError("BAD_REQUEST", message(`questions.${part}`))')).toBe(false);
  expect(judge('new ORPCError("BAD_REQUEST", message("questions." + part))')).toBe(false);
  expect(judge('new ORPCError("BAD_REQUEST", external("From " + server))')).toBe(false);
  expect(judge('new ORPCError("BAD_REQUEST", { message: message("a").message + message("b").message, data: message("a").data })')).toBe(false);
  expect(judge('new ORPCError("BAD_REQUEST", message("questions.notFound") + message("questions.answer.mismatch"))')).toBe(false);
  expect(judge('new EngineError("INVALID", "The chat is over")')).toBe(false);
  expect(judge('new EngineError("INVALID", message("questions.answer.chooseScope"))')).toBe(true);
});
