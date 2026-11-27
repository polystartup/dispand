import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import { callOf, literal, owner, parse, unwrap, where } from "../test-support-source.ts";

// Every place the server (the engine and the cloud loop) gives a model session text sits in a
// function listed here, which says where that text comes from: a start's `prompt` or
// `systemPrompt`, a message or a steer (`adapter.send`, `adapter.steer`), a user turn of the cloud
// loop (`role: "user"`). A new one fails until it is listed, so whoever adds it decides whether
// someone else's text goes in it; if it does, that text goes through `prompt-data.ts`, in a block.
// The runner writes one such text itself, an ask's answer (`apps/runner/src/outcome.ts`). The
// sources are read as code (`test-support-source.ts`), formatting aside.

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
 * - guidance: text others wrote that is meant to steer the agent (memory), bounded by its own rules;
 * - carried: text another listed site made, passed on whole;
 * - none: no text a session gets.
 */
type Kind = "rendered" | "answers" | "own" | "guidance" | "carried" | "none";

/** `file#path` (`owner`'s path): its kind, how many sites it holds, and why. */
const CLASSIFIED: Record<string, [Kind, number, string]> = {
  "engine/engine.ts#Engine.createJob": ["own", 1, "the snapshot's system prompt: the agent's instructions (`jobSystemPrompt`)"],
  "engine/engine.ts#Engine.chatInput": ["own", 1, "the person's own message, stored to send"],
  "engine/engine.ts#Engine.steerQueued": ["own", 1, "the person's own queued message, stored to steer with"],
  "engine/engine.ts#Engine.resumeClaimed": ["carried", 2, "`resumePrompt`: the start's prompt, `answerText`'s answers and the owner's messages"],
  "engine/engine.ts#Engine.openSession": ["rendered", 2, "the step's prompt through `renderPrompt`, then the owner's and the agent's earlier words"],
  "engine/engine.ts#Engine.deliverAnswer": ["answers", 1, "an orphaned answer as words (`answerText`)"],
  "engine/engine.ts#Engine.deliverMessage": ["own", 2, "the person's own message"],
  "engine/job-def.ts#jobDef": [
    "rendered",
    4,
    "the step's template: the trigger's instructions and the platform's prompts, filled by `renderPrompt` in `openSession`",
  ],
  "engine/job-reads.ts#withMemory": [
    "guidance",
    2,
    "the agent's instructions, the time zone, and the memory the owner and agents keep for later Jobs (`docs/security/agents.md`)",
  ],
  "engine/session-harness.ts#sessionHarness": ["own", 3, "the agent's instructions"],
  "engine/answers.ts#resumePrompt": ["carried", 2, "the start's prompt, `answerText`'s answers and the owner's messages"],
  "engine/routing-adapter.ts#RoutingAdapter.send": ["carried", 1, "forwards what the engine sends"],
  "engine/routing-adapter.ts#RoutingAdapter.steer": ["carried", 2, "forwards what the engine sends"],
  "engine/problems.ts#startProblem": ["none", 2, "names the start's fields in a problem's message"],
  "engine/views.ts#stepView": ["none", 1, "the step's prompt as its session got it, shown to the owner"],
  "cloud/runner.ts#CloudRunner.start": ["carried", 2, "the start's prompt and system prompt"],
  "cloud/runner.ts#CloudRunner.modelCall": [
    "carried",
    3,
    "the queued messages and answers the engine sent, and the platform's reminder of the outputs to give",
  ],
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
  // Each function holds as many sites as listed: one more in a listed function fails too.
  const counted = Object.fromEntries(Object.keys(CLASSIFIED).map((k) => [k, all.filter((s) => key(s) === k).length]));
  expect(counted).toEqual(Object.fromEntries(Object.entries(CLASSIFIED).map(([k, [, sites]]) => [k, sites])));
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
