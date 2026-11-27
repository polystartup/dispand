import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import { callOf, literal, owner, parse, unwrap, where } from "../test-support-source.ts";

// Every place the engine or the cloud runner gives a model session text sits in a function listed
// here, which says where that text comes from: a start's `prompt` or `systemPrompt`, a message or a
// steer (`adapter.send`, `adapter.steer`), a user turn of the cloud loop (`role: "user"`). A new one
// fails until it is listed, so whoever adds it decides whether someone else's text goes in it; if
// it does, that text goes through `prompt-data.ts`, in a block. The sources are read as code
// (`test-support-source.ts`), formatting aside.

const SRC = join(import.meta.dirname, "..");
const ENGINE = readdirSync(import.meta.dirname)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => join(import.meta.dirname, f));
const FILES = [...ENGINE, join(SRC, "cloud/runner.ts")];
const SOURCES = FILES.map((path) => ({ file: relative(SRC, path), source: parse(path, readFileSync(path, "utf8")) }));

/**
 * - rendered: a template filled by `renderPrompt`, someone else's values in blocks;
 * - answers: `answerText`, an agent's answer in a block;
 * - own: the words of the prompt's own author (a person's message, the agent's instructions) or the
 *   platform's text;
 * - carried: text another listed site made, passed on whole;
 * - none: no text a session gets.
 */
type Kind = "rendered" | "answers" | "own" | "carried" | "none";

/** `file#path` (`owner`'s path): its kind, and why. */
const CLASSIFIED: Record<string, [Kind, string]> = {
  "engine/engine.ts#Engine.createJob": ["own", "the snapshot's system prompt: the agent's instructions (`jobSystemPrompt`)"],
  "engine/engine.ts#Engine.chatInput": ["own", "the person's own message, stored to send"],
  "engine/engine.ts#Engine.steerQueued": ["own", "the person's own queued message, stored to steer with"],
  "engine/engine.ts#Engine.resumeClaimed": ["carried", "`resumePrompt`: the start's prompt, `answerText`'s answers and the owner's messages"],
  "engine/engine.ts#Engine.openSession": ["rendered", "the step's prompt through `renderPrompt`, then the owner's and the agent's earlier words"],
  "engine/engine.ts#Engine.deliverAnswer": ["answers", "an orphaned answer as words (`answerText`)"],
  "engine/engine.ts#Engine.deliverMessage": ["own", "the person's own message"],
  "engine/job-def.ts#jobDef": [
    "rendered",
    "the step's template: the trigger's instructions and the platform's prompts, filled by `renderPrompt` in `openSession`",
  ],
  "engine/job-reads.ts#withMemory": ["own", "the agent's instructions, the time zone and the memory the owner and agents keep for later Jobs"],
  "engine/session-harness.ts#sessionHarness": ["own", "the agent's instructions"],
  "engine/answers.ts#resumePrompt": ["carried", "the start's prompt, `answerText`'s answers and the owner's messages"],
  "engine/routing-adapter.ts#RoutingAdapter.send": ["carried", "forwards what the engine sends"],
  "engine/routing-adapter.ts#RoutingAdapter.steer": ["carried", "forwards what the engine sends"],
  "engine/problems.ts#startProblem": ["none", "names the start's fields in a problem's message"],
  "engine/views.ts#stepView": ["none", "the step's prompt as its session got it, shown to the owner"],
  "cloud/runner.ts#CloudRunner.start": ["carried", "the start's prompt and system prompt"],
  "cloud/runner.ts#CloudRunner.modelCall": ["carried", "the queued messages and answers the engine sent, and the platform's reminder of the outputs to give"],
};

type Site = { file: string; at: ts.Node; what: string };

const PROMPTS = ["prompt", "systemPrompt"];

/** Each `prompt:` or `systemPrompt:` given an object, each `adapter.send(` or `.steer(`, and each `role: "user"`. */
function sites(): Site[] {
  return SOURCES.flatMap(({ file, source }) => {
    const found: Site[] = [];
    const visit = (node: ts.Node) => {
      if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && ts.isIdentifier(node.name)) {
        if (PROMPTS.includes(node.name.text)) found.push({ file, at: node, what: node.name.text });
        if (node.name.text === "role" && ts.isPropertyAssignment(node) && literal(node.initializer) === "user")
          found.push({ file, at: node, what: 'role: "user"' });
      }
      if (ts.isPropertyAccessExpression(node) && ["send", "steer"].includes(node.name.text) && callOf(node.name)) {
        // `this.adapter.send(`, `adapter.send(`, `(await this.adapterOf(id)).send(`.
        const held = unwrap(node.expression);
        const on = ts.isAwaitExpression(held) ? unwrap(held.expression) : held;
        const callee = ts.isCallExpression(on) ? on.expression : on;
        const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : "";
        if (name === "adapter" || name === "adapterOf") found.push({ file, at: node, what: node.getText() });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  });
}

const key = (site: Site) => `${site.file}#${owner(site.at)?.path ?? `? (${where(site.at)})`}`;

test("every place a model session is given text is classified", () => {
  const all = sites();
  expect(all.filter((s) => !CLASSIFIED[key(s)]).map((s) => `${key(s)}: ${s.what} at ${where(s.at)}`)).toEqual([]);
  const found = new Set(all.map(key));
  expect(Object.keys(CLASSIFIED).filter((k) => !found.has(k))).toEqual([]);
});

test("a run's prompt is filled only through renderPrompt, which shows someone else's values in blocks", () => {
  const callers = (dir: string): string[] =>
    readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .flatMap((f) => {
        const source = parse(join(dir, f), readFileSync(join(dir, f), "utf8"));
        const calls: string[] = [];
        const visit = (node: ts.Node) => {
          if (ts.isIdentifier(node) && node.text === "renderTemplate" && callOf(node)) calls.push(`${relative(SRC, join(dir, f))}#${owner(node)?.path}`);
          ts.forEachChild(node, visit);
        };
        visit(source);
        return calls;
      });
  expect(callers(SRC)).toEqual(["engine/prompt-data.ts#renderPrompt"]);
});
