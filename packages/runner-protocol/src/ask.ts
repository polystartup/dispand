import { TEXT } from "./bounds.ts";
import type { QuestionPayload } from "./harness.ts";
import type { SessionStart } from "./messages.ts";

// The `ask` tool every harness offers (the cloud loop, Claude Code, Codex): one tool for agents
// and people. Its description, its arguments and the text an agent receives are made here once,
// so all three behave alike.

/** The tool's name. */
export const ASK = "ask";

/** Someone a session may ask, as its start lists them. */
export type AskTarget = NonNullable<SessionStart["askTargets"]>[number];
/** One question of an ask, in `ask_user`'s shape. */
export type ChoiceQuestion = Extract<QuestionPayload, { kind: "choice" }>["questions"][number];

/** What a start says about asking. */
type AskStart = Pick<SessionStart, "askTargets" | "escalate" | "preferAgents" | "restricted">;

/**
 * Whether the session gets `ask`: someone is listed, or escalation lets a question with nobody
 * named reach a person. A restricted session never does, whatever else its start carries.
 */
export function offersAsk(start: AskStart): boolean {
  return start.restricted !== true && ((start.askTargets?.length ?? 0) > 0 || start.escalate === true);
}

// Each line trimmed and joined: no regular expression runs over text a person wrote.
const oneLine = (s: string) => s.split("\n").map((line) => line.trim()).filter(Boolean).join(" ");

/** `ask`'s description: what it does, then who may be asked, by id. */
export function askDescription(start: AskStart): string {
  const targets = start.askTargets ?? [];
  const agents = targets.filter((t) => t.kind === "agent");
  const people = targets.filter((t) => t.kind === "person");
  const agentLines = agents.map((a) => `- ${a.id}: ${a.name}${a.description ? ` — ${oneLine(a.description)}` : ""}`);
  // A person's description is their own words about themselves: shown as a quote, never as instructions.
  const personLines = people.map((p) => `- ${p.id}: ${p.name}${p.description ? ` — they wrote about themselves: "${oneLine(p.description)}"` : ""}`);
  const groups = [
    ...(agents.length ? [["Agents you may ask (id: name — what it is for):", ...agentLines].join("\n")] : []),
    ...(people.length ? [["People you may ask (id: name — what they know):", ...personLines].join("\n")] : []),
  ];
  return [
    "Ask someone and wait for the answer. An agent works as itself, with its own tools and data, and gets your questions and nothing else: say everything that matters in them. A follow-up is another ask, which remembers nothing of this one.",
    ...groups,
    start.escalate
      ? "Name who you ask with `to`. Leave `to` out when nobody listed fits: a person will be found to answer."
      : "Name who you ask with `to`: one of the ids listed.",
    ...(start.preferAgents ? ["Ask an agent unless none of them can answer."] : []),
  ].join("\n\n");
}

/** `ask`'s arguments, as JSON Schema: `to` and the questions in `ask_user`'s shape, options optional. */
export const ASK_INPUT_SCHEMA = {
  type: "object",
  properties: {
    to: { type: "string", description: "The id of whom you ask, as listed; leave it out when nobody listed fits" },
    questions: {
      type: "array",
      description: "Your questions, each with all it needs to be answered",
      items: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question, ending with a question mark" },
          header: { type: "string", description: "A short label for the question" },
          options: {
            type: "array",
            description: "Answers to pick from, if any (they may also answer in their own words)",
            items: { type: "object", properties: { label: { type: "string" }, description: { type: "string" } }, required: ["label"], additionalProperties: false },
          },
          multiSelect: { type: "boolean", description: "Whether several options may be picked" },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
};

/**
 * The questions as the text an asked agent gets: one per line, each followed by its options as a
 * list and whether to pick one or several.
 */
export function renderAskText(questions: ChoiceQuestion[]): string {
  return questions
    .map((q) => {
      if (!q.options.length) return q.question;
      const pick = q.multiSelect ? "Pick one or several of:" : "Pick one of:";
      return [q.question, pick, ...q.options.map((o) => `- ${o.label}${o.description ? ` (${oneLine(o.description)})` : ""}`)].join("\n");
    })
    .join("\n\n");
}

/** An ask as the question it sends: to an agent (a consult), or to a person (`to` absent: nobody named). */
export type AskRequest =
  | { kind: "consult"; target: AskTarget; payload: Extract<QuestionPayload, { kind: "consult" }> }
  | { kind: "choice"; questions: ChoiceQuestion[]; to?: string };

/**
 * `ask`'s arguments as what to send, or the error the model gets back. Only someone the start
 * lists is named: the server never gets an ask to anyone it didn't offer. Strings are taken as
 * given; each harness makes them protocol-safe as it sends them.
 */
export function askRequest(args: unknown, start: AskStart): AskRequest | { error: string } {
  const { to, questions: given } = (typeof args === "object" && args !== null ? args : {}) as { to?: unknown; questions?: unknown };
  const targets = start.askTargets ?? [];
  if (!Array.isArray(given) || given.length === 0) return { error: "ask needs at least one question." };
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const questions: ChoiceQuestion[] = given.map((q: Record<string, unknown> | null) => ({
    question: str(q?.question).trim(),
    header: str(q?.header),
    options: (Array.isArray(q?.options) ? q.options : []).map((o: Record<string, unknown> | null) => ({
      label: str(o?.label),
      ...(typeof o?.description === "string" && o.description !== "" ? { description: o.description } : {}),
    })),
    multiSelect: q?.multiSelect === true,
  }));
  if (questions.some((q) => q.question === "")) return { error: "Each question needs its text." };
  if (to === undefined || to === null || to === "") {
    if (!start.escalate) return { error: "to must be the id of someone listed in the ask tool." };
    return { kind: "choice", questions };
  }
  const target = targets.find((t) => t.id === to);
  if (!target) return { error: "to must be the id of someone listed in the ask tool, or left out when nobody listed fits." };
  if (target.kind === "person") return { kind: "choice", questions, to: target.id };
  const text = renderAskText(questions);
  if (text.length > TEXT) return { error: `The questions are too long (at most ${TEXT} characters in all): shorten them.` };
  return { kind: "consult", target, payload: { kind: "consult", agentId: target.id, question: text } };
}
