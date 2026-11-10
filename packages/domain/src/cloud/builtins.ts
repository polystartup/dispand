import { HarnessEvent, type OutputField, type QuestionPayload, TEXT } from "@dispand/runner-protocol";
import type { ToolSpec } from "./model-client.ts";

// The tools a cloud session answers itself, with the shapes and texts of the runner's Claude
// sessions (`apps/runner/src/claude.ts`), so both harnesses behave alike for the engine and the owner.

export const ASK_USER = "ask_user";
export const SUBMIT_OUTPUTS = "submit_outputs";
export const REQUEST_APPROVAL = "request_approval";
/** The most characters an approval request's words may hold: the owner reads them whole. */
export const MAX_APPROVAL_MESSAGE = 4000;

/** Outputs travel in one event (outputs-accepted, and confirm-outputs), as on the runner. */
const OUTPUTS_BYTES = 512 * 1024;

const strictObject = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** Same shape as Claude Code's `AskUserQuestion`. */
export const askUserSpec: ToolSpec = {
  name: ASK_USER,
  description:
    "Ask the owner one or more questions, each with options to pick from (they may also answer in their own words). Use it when you need their decision.",
  inputSchema: strictObject({
    questions: {
      type: "array",
      items: strictObject({
        question: { type: "string", description: "The question, ending with a question mark" },
        header: { type: "string", description: "A short label for the question" },
        options: {
          type: "array",
          items: strictObject({ label: { type: "string" }, description: { type: "string", description: "What this option means (may be empty)" } }),
        },
        multiSelect: { type: "boolean", description: "Whether several options may be picked" },
      }),
    },
  }),
};

export function submitOutputsSpec(fields: OutputField[]): ToolSpec {
  return {
    name: SUBMIT_OUTPUTS,
    description: "Hand your results back to Dispand. Call it once you have every value.",
    inputSchema: strictObject(Object.fromEntries(fields.map((f) => [f.name, { type: "string", description: f.description ?? f.name }]))),
  };
}

/** Makes text storable in Postgres (no U+0000, no lone surrogate), as the runner does with every protocol string. */
export function storableText(s: string): string {
  return s.replaceAll("\u0000", "�").toWellFormed();
}

/** A question event, if the protocol carries it as is (the owner sees exactly what was asked). */
export function questionEvent(questionId: string, payload: QuestionPayload): HarnessEvent | null {
  const parsed = HarnessEvent.safeParse({ type: "question", questionId, payload });
  return parsed.success ? parsed.data : null;
}

const TOO_LONG_QUESTIONS = "These questions are too long to tell apart once shown to the owner: shorten them and ask again.";

/** `ask_user` arguments as a choice question, or the error the model gets back. */
export function askUserPayload(args: unknown): { payload: QuestionPayload } | { error: string } {
  const questions = (args as { questions?: unknown })?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return { error: "ask_user needs at least one question." };
  const shaped = questions.map((q: { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown }) => ({
    question: q?.question,
    header: q?.header,
    options: Array.isArray(q?.options)
      ? q.options.map((o: { label?: unknown; description?: unknown }) => ({
          label: o?.label,
          ...(typeof o?.description === "string" && o.description !== "" ? { description: o.description } : {}),
        }))
      : q?.options,
    multiSelect: q?.multiSelect ?? false,
  }));
  const payload = { kind: "choice", questions: shaped } as QuestionPayload;
  if (!questionEvent("", payload)) return { error: TOO_LONG_QUESTIONS };
  // Answers are keyed by question text, and options picked by label: both must be distinct.
  const distinct = (texts: string[]) => new Set(texts).size === texts.length;
  const choice = payload as Extract<QuestionPayload, { kind: "choice" }>;
  if (!distinct(choice.questions.map((q) => q.question)) || choice.questions.some((q) => !distinct(q.options.map((o) => o.label)))) {
    return { error: TOO_LONG_QUESTIONS };
  }
  return { payload };
}

/** `submit_outputs` arguments as the expected values, or the error the model gets back. */
export function outputValues(args: unknown, fields: OutputField[]): { values: Record<string, string> } | { error: string } {
  const given = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const missing = fields.filter((f) => typeof given[f.name] !== "string").map((f) => f.name);
  if (missing.length > 0) return { error: `Missing outputs: ${missing.join(", ")}. Call submit_outputs again with every value, as text.` };
  const raw = Object.fromEntries(fields.map((f) => [f.name, given[f.name] as string]));
  if (Object.values(raw).some((v) => v.length > TEXT) || Buffer.byteLength(JSON.stringify(raw)) > OUTPUTS_BYTES) {
    return { error: `The outputs are too large: at most ${TEXT} characters each and 512 KiB in all. Shorten them and call submit_outputs again.` };
  }
  return { values: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, storableText(v)])) };
}

export const requestApprovalSpec: ToolSpec = {
  name: REQUEST_APPROVAL,
  description:
    "Ask the owner to approve something before you do it, in your own words (for example: \"Send this draft to the client?\"). They answer yes or no; a no may come with a reason. Use it before an action that matters and can't be undone, and wait for the answer before acting.",
  // `proposal` is optional, so the schema isn't sent as strict: the arguments are checked here (`approvalMessage`).
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "What you ask to be approved, as one clear question" },
      proposal: { type: "string", description: "The id propose gave you, when you ask for a proposal: the owner then approves its listed writes" },
    },
    required: ["message"],
    additionalProperties: false,
  },
};

/** What an id of a proposal looks like: anything else given as one is a bad call, never a request without a proposal. */
const PROPOSAL_ID = /^[A-Za-z0-9_]{1,64}$/;

/** `request_approval` arguments as the words to show (and the proposal they ask for), or the error the model gets back. */
export function approvalMessage(args: unknown): { message: string; proposal?: string } | { error: string } {
  const { message, proposal } = (args ?? {}) as { message?: unknown; proposal?: unknown };
  if (typeof message !== "string" || message.trim() === "") return { error: "request_approval needs a message: what you ask to be approved." };
  if (message.trim().length > MAX_APPROVAL_MESSAGE) return { error: `The message is too long to show whole (at most ${MAX_APPROVAL_MESSAGE} characters): shorten it.` };
  if (proposal !== undefined && (typeof proposal !== "string" || !PROPOSAL_ID.test(proposal))) return { error: "proposal must be the id propose gave you; leave it out to ask in words only." };
  return { message: storableText(message.trim()), ...(proposal === undefined ? {} : { proposal }) };
}

export const TEXTS = {
  approved: "Approved.",
  notRunAfterDenial: "Not run: the owner denied the approval you asked for in the same turn.",
  confirmed: "confirmed",
  notConfirmed: "The owner did not confirm these values.",
  denied: "The owner denied this.",
  notAnswered: "The question was not answered.",
  tooLargeToAsk: "The tool input is too large to show for approval (or holds characters that can't be shown): split it up.",
  restarted: "Dispand restarted while this call was running: it may or may not have run. Check before retrying.",
  invalidArgs: (name: string) => `The arguments for ${name} weren't valid JSON: call it again with valid JSON.`,
  unknownTool: (name: string) => `There is no tool named ${name}.`,
  reminder: (fields: OutputField[]) => `Call submit_outputs with: ${fields.map((f) => f.name).join(", ")}`,
};
