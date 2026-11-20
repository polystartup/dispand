import { type Answer, type QuestionPayload, TEXT } from "@dispand/runner-protocol";
import type { MessageRow, QuestionRow } from "./views.ts";

/** Sent as the first message of a session resumed after its runner lost it. */
export const RESUME_PROMPT = "Dispand reconnected after an interruption. Continue where you left off.";

/** Who gave an agent's answer (`inbox`), as the asking Job is told it. */
const answeredByAgent = (name: string) => `Answered by the agent ${name}`;

/**
 * An agent's choice answer as a CLI session gets it: a CLI shows any answer as the owner's, so
 * each question's answer says, in its own words, which agent gave it (a label so changed reaches
 * the CLI as free text, whole). It goes with the answer: the session resumes on it.
 */
export function attributed(answer: Answer, name: string): Answer {
  if (answer.kind !== "choice") return answer;
  const note = ` (${answeredByAgent(name)}, not by the owner)`;
  const answers = Object.fromEntries(
    Object.entries(answer.answers).map(([question, given]) => [question, Array.isArray(given) ? given.map((g, i) => (i === given.length - 1 ? g + note : g)) : given + note]),
  );
  return { kind: "choice", answers };
}

/** The words of an approval asked with `request_approval`; null for any other question. */
function approvalWords(payload: QuestionPayload): string | null {
  if (payload.kind !== "permission" || payload.toolName !== "request_approval") return null;
  const message = (payload.input as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : null;
}

/** An answer in words, for a session that can only get it as a message. */
export function answerText(q: Pick<QuestionRow, "payload" | "answer"> & Partial<Pick<QuestionRow, "answeredBy">>): string {
  const a = q.answer!;
  if (a.kind === "consult") {
    // The answer of the agent consulted, which the asker is told it is from; or why there is none.
    if (a.outcome === "failed") return `Your consult got no answer: ${a.text}`.slice(0, TEXT);
    const name = q.answeredBy?.type === "agent" ? q.answeredBy.name : "consulted";
    return `Answer from the agent ${name}:\n\n${a.text}`.slice(0, TEXT);
  }
  if (a.kind === "choice") {
    const parts = Object.entries(a.answers).map(([question, answer]) => `“${question}”: ${Array.isArray(answer) ? answer.join(", ") : answer}`);
    return `${q.answeredBy?.type === "agent" ? answeredByAgent(q.answeredBy.name) : "The owner answered"}: ${parts.join("; ")}.`;
  }
  if (a.kind === "permission") {
    const asked = approvalWords(q.payload);
    // An approval the agent asked for in its own words: told back with those words.
    if (asked !== null) return `The owner ${a.decision === "deny" ? "denied" : "approved"} your request (“${asked.slice(0, 500).toWellFormed()}”)${a.message ? `: ${a.message}` : "."}`;
    const tool = q.payload.kind === "permission" ? q.payload.toolName : "the tool";
    const verdict = a.decision === "deny" ? "denied" : "allowed";
    const scope = a.remember === "run" ? " for this run" : a.remember === "always" ? " for this and future runs" : "";
    return `The owner ${verdict} ${tool}${scope}${a.message ? `: ${a.message}` : "."}`;
  }
  return a.confirmed
    ? "The owner confirmed your values: call submit_outputs again with them."
    : `The owner did not confirm your values${a.feedback ? `: ${a.feedback}` : "."}`;
}

function questionText(q: QuestionRow): string {
  const p = q.payload;
  if (p.kind === "choice") return p.questions.map((x) => `“${x.question}”`).join(", ");
  if (approvalWords(p) !== null) return "your approval request";
  if (p.kind === "consult") return "the answer of the agent you consulted";
  if (p.kind === "permission") return `permission to use ${p.toolName}`;
  return "confirmation of your values";
}
/**
 * The conversation so far, for a chat's fresh session that doesn't have it (its transcript is
 * gone, or its harness changed), in at most `room` characters: the newest kept when it doesn't all
 * fit. Empty when there is nothing earlier.
 */
export function earlierConversation(rows: Pick<MessageRow, "role" | "text">[], room: number): string {
  const lines = rows.flatMap((m) => (m.role === "assistant" ? [`You answered: ${m.text}`] : m.role === "user" ? [`The owner wrote: ${m.text}`] : []));
  const head = "Earlier in this conversation, in a session that has ended (context: don't redo what it already did):";
  const kept: string[] = [];
  let length = head.length;
  for (const line of lines.reverse()) {
    if (length + 2 + line.length > room) break;
    kept.unshift(line);
    length += 2 + line.length;
  }
  return kept.length ? [head, ...kept].join("\n\n") : "";
}

/**
 * The first message of a resumed session: what it missed while it was gone, as much as fits the
 * protocol's prompt limit (oldest first). What doesn't fit is returned, to follow as messages.
 */
export function resumePrompt(
  original: string | null,
  answered: QuestionRow[],
  unsent: MessageRow[],
  waiting: QuestionRow[],
): { prompt: string; answers: QuestionRow[]; messages: MessageRow[]; laterAnswers: QuestionRow[]; laterMessages: MessageRow[] } {
  // A native command must be the first text the harness sees, not quoted transcript prose.
  if (original === null && !answered.length && !waiting.length && unsent[0]?.text.startsWith("/") && !unsent[0].files?.length) {
    return { prompt: unsent[0].text, answers: [], messages: [unsent[0]], laterAnswers: [], laterMessages: unsent.slice(1) };
  }
  // An empty original (a chat whose trigger has no instructions) adds nothing.
  const parts = original === "" ? [] : [original ?? RESUME_PROMPT];
  let length = parts[0]?.length ?? 0;
  const waitingLine =
    waiting.length > 0 ? `Still waiting for the owner: ${waiting.map(questionText).join("; ")}. Their answer will come as a message.` : "";
  const room = TEXT - (waitingLine ? waitingLine.length + 2 : 0);
  let full = false;
  const fits = (text: string) => {
    if (!full && length + 2 + text.length <= room) {
      parts.push(text);
      length += 2 + text.length;
      return true;
    }
    // Once something doesn't fit, the rest follows it, so the order holds.
    full = true;
    return false;
  };
  const answers = answered.filter((q) => fits(answerText(q)));
  // A message with files goes as itself, which carries them (the prompt can't): it and the rest follow.
  const messages = unsent.filter((m) => (m.files?.length ? ((full = true), false) : fits(`The owner wrote: ${m.text}`)));
  if (waitingLine && length + 2 + waitingLine.length <= TEXT) parts.push(waitingLine);
  return {
    prompt: parts.join("\n\n"),
    answers,
    messages,
    laterAnswers: answered.slice(answers.length),
    laterMessages: unsent.slice(messages.length),
  };
}
