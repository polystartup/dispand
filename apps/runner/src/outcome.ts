// What every CLI session shares, whatever its harness: questions to the owner, `submit_outputs`
// (and its confirmation) and what a turn's end means for the session (turn-end, reminder, result).
import { randomUUID } from "node:crypto";
import { type Answer, type HarnessEvent, type OutputField, type QuestionPayload, TEXT } from "@dispand/runner-protocol";
import { protocolEvents, protocolString } from "./sanitize.ts";

/** A running CLI session, as `Sessions` drives it. */
export type HarnessSession = {
  /** Sends the owner's next message. */
  send(text: string): void;
  /** Answers a question the session emitted. */
  answer(questionId: string, answer: Answer): void;
  interrupt(): Promise<void>;
  /** Ends the session: the CLI exits once its current turn is done. */
  close(): void;
  /** Ends the session now with an `error` event: the CLI is stopped, queued work dropped. */
  stop(message: string): void;
  /** Ends the session now without any event (the runner is stopping; it can be resumed): the CLI is stopped. */
  abort(): void;
  /** Settles when the CLI has exited. */
  done: Promise<void>;
  /** Tool calls started and not finished yet (their names are kept until their result). */
  toolsInFlight(): number;
};

/** `bypassPermissions` asked for while the machine's config doesn't allow it. */
export class BypassRefused extends Error {
  override name = "BypassRefused";
  constructor() {
    super("bypassPermissions is not allowed by this runner's config (allowBypass)");
  }
}

/**
 * Messages sent to a session whose turn hasn't ended yet (read by the CLI or not), on top of the
 * one running, and their bytes: past either, a send is refused.
 */
export const MAX_WAITING = 20;
export const MAX_WAITING_BYTES = 4 * 1024 * 1024;

/** Outputs travel in one event (outputs-accepted, and confirm-outputs): well under the hub's 1 MiB frames. */
const OUTPUTS_BYTES = 512 * 1024;

/** Questions the session asked the owner and is waiting on, by question id. */
export function ownerQuestions(emit: (e: HarnessEvent) => void) {
  const pending = new Map<string, (answer: Answer) => void>();
  return {
    /** Asks the owner; null once `signal` withdraws the question (a late answer then finds nothing). */
    ask(payload: QuestionPayload, signal?: AbortSignal): Promise<Answer | null> {
      const questionId = randomUUID();
      return new Promise((resolve) => {
        pending.set(questionId, resolve);
        signal?.addEventListener("abort", () => {
          pending.delete(questionId);
          resolve(null);
        });
        emit({ type: "question", questionId, payload });
      });
    },
    answer(questionId: string, answer: Answer) {
      const resolve = pending.get(questionId);
      pending.delete(questionId);
      resolve?.(answer);
    },
    /** The session ended: every question still open is denied. */
    endAll() {
      for (const resolve of pending.values()) resolve({ kind: "permission", decision: "deny", message: "The session ended." });
      pending.clear();
    },
  };
}

export type ChoiceQuestion = Extract<QuestionPayload, { kind: "choice" }>["questions"][number];

/**
 * Asks the agent's questions as one `choice` question. The owner sees (and answers under) the
 * questions as the protocol carries them, maybe cut; the answers come back per question, in the
 * agent's own labels (anything else, free text, as written). "indistinct" when the cut made
 * questions, or options of one, identical (or left some out): the owner answers only what they
 * can tell apart, so nothing is asked. Null when the question wasn't answered.
 */
export async function askChoices(
  ask: (payload: QuestionPayload, signal?: AbortSignal) => Promise<Answer | null>,
  questions: ChoiceQuestion[],
  signal?: AbortSignal,
): Promise<(string[] | undefined)[] | "indistinct" | null> {
  const [shown] = protocolEvents({ type: "question", questionId: "", payload: { kind: "choice", questions } });
  const shownQuestions = shown?.type === "question" && shown.payload.kind === "choice" ? shown.payload.questions : [];
  const distinct = (texts: string[]) => new Set(texts).size === texts.length;
  if (
    shownQuestions.length !== questions.length ||
    !distinct(shownQuestions.map((q) => q.question)) ||
    shownQuestions.some((q, i) => q.options.length !== (questions[i]?.options.length ?? 0) || !distinct(q.options.map((o) => o.label)))
  ) {
    return "indistinct";
  }
  const answer = await ask({ kind: "choice", questions: shownQuestions }, signal);
  if (answer?.kind !== "choice") return null;
  return questions.map((q, i) => {
    const shownQ = shownQuestions[i]!;
    const a = answer.answers[shownQ.question];
    if (a === undefined) return undefined;
    // Labels back to the agent's own text, as the question text is.
    const original = (label: string) => q.options[shownQ.options.findIndex((o) => o.label === label)]?.label ?? label;
    return (Array.isArray(a) ? a : [a]).map(original);
  });
}

/** How a turn ended, as the CLI reported it. */
export type TurnEnd = {
  /** Cut short: interrupted from Dispand, or aborted by the CLI. */
  interrupted: boolean;
  /** Why the turn failed (ignored for a cut turn). */
  error?: string;
  /** The turn's final text. */
  text: string;
  /** Messages are still queued: their turns run next. */
  queued: boolean;
};

/**
 * The session's outcome: `submit_outputs` hands the agent's results back (confirmed by the owner
 * in an interactive session), and each turn's end decides whether the session waits for the owner,
 * reminds the agent once, or finishes with a result or an error.
 */
export function sessionOutcome(
  start: { expectedOutputs: OutputField[]; interactive: boolean },
  io: {
    emit: (e: HarnessEvent) => void;
    ask: (payload: QuestionPayload, signal?: AbortSignal) => Promise<Answer | null>;
    /** The session's last event. */
    finish: (e: HarnessEvent) => void;
    /** Queues a message to the agent. */
    say: (text: string) => void;
  },
) {
  let accepted = false;
  let reminded = false;
  return {
    /** `submit_outputs` with the agent's arguments: the text returned to it as the tool's result. */
    async submit(given: Record<string, unknown>, signal: AbortSignal): Promise<string> {
      // Only the expected fields, each a string: what isn't there is asked for again.
      const missing = start.expectedOutputs.filter((f) => typeof given[f.name] !== "string").map((f) => f.name);
      if (missing.length > 0) return `Missing outputs: ${missing.join(", ")}. Call submit_outputs again with every value, as text.`;
      const raw = Object.fromEntries(start.expectedOutputs.map((f) => [f.name, given[f.name] as string]));
      // Cutting outputs would change them: the agent shortens them instead.
      if (Object.values(raw).some((v) => v.length > TEXT) || Buffer.byteLength(JSON.stringify(raw)) > OUTPUTS_BYTES) {
        return `The outputs are too large: at most ${TEXT} characters each and 512 KiB in all. Shorten them and call submit_outputs again.`;
      }
      const values = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, protocolString(v, TEXT)]));
      if (start.interactive) {
        // Withdrawn when the call is cancelled or its turn interrupted: a late answer finds nothing to resolve.
        const answer = await io.ask({ kind: "confirm-outputs", values }, signal);
        if (answer === null) return "Interrupted before the owner confirmed these values.";
        if (answer.kind !== "confirm-outputs" || !answer.confirmed) {
          const feedback = answer?.kind === "confirm-outputs" ? answer.feedback : undefined;
          return feedback || "The owner did not confirm these values.";
        }
      }
      accepted = true;
      io.emit({ type: "outputs-accepted", values });
      return "confirmed";
    },

    turnEnded(turn: TurnEnd) {
      if (turn.interrupted) {
        if (accepted) return io.finish({ type: "result", text: turn.text });
        // Interactive: it waits for the owner's next message, like any turn end, unless a follow-up
        // is still queued (it runs next, so the session isn't idle). No reminder either way.
        if (start.interactive) return turn.queued ? undefined : io.emit({ type: "turn-end" });
        return io.finish({ type: "error", message: "interrupted" });
      }
      if (turn.error !== undefined) return io.finish({ type: "error", message: turn.error });
      // More messages are queued: their turns run next, so the session isn't waiting yet.
      if (turn.queued && !accepted) return;
      // A session that expects no outputs is done when a non-interactive turn ends.
      if (accepted || (!start.interactive && start.expectedOutputs.length === 0)) return io.finish({ type: "result", text: turn.text });
      if (start.interactive) return io.emit({ type: "turn-end" });
      if (reminded) return io.finish({ type: "error", message: "the agent finished without its outputs" });
      reminded = true;
      io.say(`Call submit_outputs with: ${start.expectedOutputs.map((f) => f.name).join(", ")}`);
    },
  };
}

/** The tool an agent asks an approval with, in its own words. */
export const REQUEST_APPROVAL = "request_approval";
/** What a tool called in the same turn as a denied approval request gets back. */
export const TURN_DENIED = "Not run: the owner denied the approval asked for in the same turn.";
export const REQUEST_APPROVAL_DESCRIPTION =
  'Ask the owner to approve something before you do it, in your own words (for example: "Send this draft to the client?"). They answer yes or no; a no may come with a reason. Use it before an action that matters and can\'t be undone, and wait for the answer before acting.';
/** The most characters the request's words may hold: the owner reads them whole. */
const MAX_APPROVAL_MESSAGE = 4000;

/**
 * Asks the owner to approve `args.message` and gives the tool's answer: "Approved.", or the
 * denial with the owner's reason. Each request asks: nothing is ever allowed for the session,
 * whatever the permission mode. `ok: false` when the request itself can't be shown.
 */
export async function requestApproval(
  ask: (payload: QuestionPayload, signal?: AbortSignal) => Promise<Answer | null>,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; text: string; approved: boolean }> {
  const message = typeof args.message === "string" ? args.message.trim() : "";
  if (!message) return { ok: false, approved: false, text: "request_approval needs a message: what you ask to be approved." };
  if (message.length > MAX_APPROVAL_MESSAGE) return { ok: false, approved: false, text: `The message is too long to show whole (at most ${MAX_APPROVAL_MESSAGE} characters): shorten it.` };
  const answer = await ask({ kind: "permission", toolName: REQUEST_APPROVAL, input: { message: protocolString(message, TEXT) }, canAlwaysAllow: false }, signal);
  if (answer?.kind !== "permission") return { ok: false, approved: false, text: "The request was not answered." };
  if (answer.decision === "deny") return { ok: true, approved: false, text: answer.message ? `Denied: ${answer.message}` : "Denied." };
  return { ok: true, approved: true, text: "Approved." };
}
