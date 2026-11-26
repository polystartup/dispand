import { ORPCError } from "@orpc/server";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import { call } from "@orpc/server";
import { z } from "zod";
import { base, validationKey } from "../rpc/context.ts";
import en from "./en.json";
import fr from "./fr.json";
import { ModelListError } from "../cloud/models.ts";
import { ENTRY_VALUES } from "../memory/model.ts";
import { PackageError } from "../skills/package.ts";
import { GitError } from "../plugins/git.ts";
import { PluginError } from "../plugins/fs.ts";
import { ToolError } from "../tools/errors.ts";
import { external, isMessageKey, type Message, message, reasonOf, rendered, plainText, stored, storedSentence, storedText } from "./index.ts";

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

test("errors that carry a message say it in French too, and in English for agents", () => {
  const unsafe = new PackageError("skills.package.unsafePath", "../x");
  expect([unsafe.message, rendered("fr", unsafe.say.key, unsafe.say.values)]).toEqual(["“../x” is not a safe path.", "« ../x » n’est pas un chemin sûr."]);
  const model = new ModelListError("harness.models.unreachable", { host: "api.example.com" });
  expect([model.message, rendered("fr", model.say.key, model.say.values)]).toEqual(["Couldn't reach api.example.com.", "Impossible de joindre api.example.com."]);
  expect(rendered("fr", "memory.entry.typeOneOf", ENTRY_VALUES)).toBe("Le type est l’un de : business, practice, fact, reference.");
});

test("a refusal of the Git, plugin and tool errors is said in French, a stored failure keyed and rendered in the reader's language, an old plain row as stored", () => {
  const url = new GitError("git.fetch.timeout", { url: "https://example.com/a.git", seconds: 60 });
  expect([url.message, rendered("fr", url.say.key, url.say.values)]).toEqual(["Couldn't fetch https://example.com/a.git: it took longer than 60 s.", "Impossible de récupérer https://example.com/a.git : cela a pris plus de 60 s."]);
  const plugin = new PluginError("pluginRead.tooManyServers", { max: 5 });
  expect(rendered("fr", plugin.say.key, plugin.say.values)).toBe("Le plugin propose plus de 5 serveurs MCP.");
  const kept = new ToolError("tools.fail.timeout", { host: "mcp.example.com" }).stored;
  expect(storedText(kept)).toEqual({ key: "tools.fail.timeout", values: { host: "mcp.example.com" } });
  const read = storedText(kept) as Message;
  expect([storedSentence(kept), rendered("fr", read.key, read.values)]).toEqual(["mcp.example.com didn't answer in time.", "mcp.example.com n’a pas répondu à temps."]);
  expect(storedText("The tool no longer exists")).toEqual({ text: "The tool no longer exists" });
  expect(storedText('{"key":"not.a.key"}')).toEqual({ text: '{"key":"not.a.key"}' });
  expect(storedSentence(stored("engine.fail.stopped"))).toBe("Stopped.");
});

test("a poll's own failure and a not-imported reason are said in French", () => {
  const failed = storedText(stored("tools.poll.nextNotText", { path: "page.next" })) as Message;
  expect([storedSentence(stored("tools.poll.notJson")), rendered("fr", failed.key, failed.values)]).toEqual(["The action's result isn't JSON.", "La page suivante du résultat, à « page.next », n’est pas un texte."]);
  expect(rendered("fr", "notImported.more", { count: 3 })).toBe("et 3 autres non importés");
  expect(rendered("fr", "pluginRead.tooManyDefinitions", { max: 100, folder: "com.dispand/agents" })).toBe("Le plugin contient plus de 100 définitions dans com.dispand/agents.");
});

test("words from outside that look like a stored message are shown as they came, and plural forms are chosen by the count", () => {
  const forged = '{"key":"engine.fail.stopped"}';
  expect(storedText(forged)).toEqual({ key: "engine.fail.stopped" });
  expect(storedText(plainText(forged))).toEqual({ text: forged });
  expect(storedText(plainText(` \n${forged}`))).toEqual({ text: ` \n${forged}` });
  expect(plainText("It broke")).toBe("It broke");
  expect([rendered("en", "engine.poll.noId", { count: 1, path: "id" }), rendered("fr", "engine.poll.noId", { count: 2, path: "id" })]).toEqual(["1 item without an id at “id” left out.", "2 éléments sans identifiant à « id » écartés."]);
});

// Errors whose text may reach a person and isn't a `message()` key or text marked as external, per
// file with exact counts: none is left, so a new unkeyed error fails.
const UNKEYED: Record<string, number> = {};

const src = join(import.meta.dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [join(dir, e.name)] : []));

/** A key or a text given whole: not a template, not a concatenation. */
const whole = (node: ts.Expression | undefined) => !!node && !ts.isTemplateExpression(node) && !ts.isBinaryExpression(node);
const callTo = (node: ts.Expression, name: string): node is ts.CallExpression => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;

/** Whether an error's options are a single `message()` key, text marked as external, a keyed engine error passed on (`passOn(err)`, typed `EngineError`), or an organization's refusal (`refusedMessage`, keyed by its install or `organization.refused`). */
function keyed(options: ts.Expression | undefined): boolean {
  if (!options) return false;
  if (callTo(options, "refusedMessage")) return true;
  if (callTo(options, "message") || callTo(options, "external")) return whole(options.arguments[0]);
  return callTo(options, "passOn") && options.arguments.length === 1 && ts.isIdentifier(options.arguments[0]!);
}

/** The errors that carry their message as a key: `new GitError("git.url")`, never a sentence built in place. */
const SAYING = ["GitError", "MarketplaceError", "WellKnownError", "ToolError", "ReauthorizeError", "PluginError"];

/** Whether a saying error's first argument is a key given whole (the type holds it to a `MessageKey`). */
const saysKey = (node: ts.NewExpression) => !!node.arguments?.[0] && whole(node.arguments[0]);

/** Every `new ORPCError(`, `new EngineError(` and saying error of a file whose message isn't keyed. */
function unkeyed(path: string): number {
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  let n = 0;
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (["ORPCError", "EngineError"].includes(name) && !keyed(node.arguments?.[1])) n++;
      if (SAYING.includes(name) && !saysKey(node)) n++;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return n;
}

test("every error of the domain says a message key or external text, except those still listed", () => {
  const found = Object.fromEntries(files(src).flatMap((path) => (unkeyed(path) ? [[relative(src, path), unkeyed(path)]] : [])));
  expect(found).toEqual(UNKEYED);
});

test("the walk holds the saying errors to a key", () => {
  const judge = (code: string) => saysKey((ts.createSourceFile("x.ts", code, ts.ScriptTarget.Latest, true).statements[0] as ts.ExpressionStatement).expression as ts.NewExpression);
  expect(judge('new GitError("git.fetch.failed", { url })')).toBe(true);
  expect(judge("new ToolError(refused.key, { host })")).toBe(true);
  expect(judge("new PluginError(`The plugin offers ${n}`)")).toBe(false);
  expect(judge('new WellKnownError("Use " + scheme)')).toBe(false);
  expect(judge("new MarketplaceError()")).toBe(false);
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

test("a refinement's own message survives validation: a key as that message, other words as external text", async () => {
  const keyed = base.input(z.string().refine(() => false, "questions.notFound")).handler(() => null);
  const plain = base.input(z.string().refine(() => false, "Plain words")).handler(() => null);
  const bare = base.input(z.string().refine(() => false)).handler(() => null);
  await expect(call(keyed, "x", { context: {} as never })).rejects.toMatchObject({ message: "This question doesn't exist.", data: { key: "questions.notFound" } });
  await expect(call(plain, "x", { context: {} as never })).rejects.toMatchObject({ message: "Plain words", data: { external: true } });
  await expect(call(bare, "x", { context: {} as never })).rejects.toMatchObject({ data: { key: "validation.custom", values: { field: "input" } } });
});
