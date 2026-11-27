// The `request_approval` tool every harness offers (the cloud loop, Claude Code, Codex): its
// name, description, arguments and their checks are made here once, so all three behave alike.

/** The tool an agent asks an approval with, in its own words. */
export const REQUEST_APPROVAL = "request_approval";

export const REQUEST_APPROVAL_DESCRIPTION =
  'Ask the owner to approve something before you do it, in your own words (for example: "Send this draft to the client?"). They answer yes or no; a no may come with a reason. Use it before an action that matters and can\'t be undone, and wait for the answer before acting.';

/** The most characters the request's words may hold: the owner reads them whole. */
export const MAX_APPROVAL_MESSAGE = 4000;

/** What each of its arguments is, as the model reads it. */
export const REQUEST_APPROVAL_ARGUMENTS = {
  message: "What you ask to be approved, as one clear question",
  proposal: "The id propose gave you, when you ask for a proposal: the owner then approves its listed writes",
} as const;

/**
 * Its arguments, as JSON Schema. `proposal` is optional, so the schema isn't sent as strict: the
 * arguments are checked when it is called (`approvalRequest`).
 */
export const REQUEST_APPROVAL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    message: { type: "string", description: REQUEST_APPROVAL_ARGUMENTS.message },
    proposal: { type: "string", description: REQUEST_APPROVAL_ARGUMENTS.proposal },
  },
  required: ["message"],
  additionalProperties: false,
};

/** What an id of a proposal looks like: anything else given as one is a bad call, never a request without a proposal. */
const PROPOSAL_ID = /^[A-Za-z0-9_]{1,64}$/;

/** The arguments of a call as the words to ask (trimmed) and the proposal they ask for, or the error the model gets back. */
export function approvalRequest(args: unknown): { message: string; proposal?: string } | { error: string } {
  const { message, proposal } = (typeof args === "object" && args !== null ? args : {}) as { message?: unknown; proposal?: unknown };
  const words = typeof message === "string" ? message.trim() : "";
  if (!words) return { error: "request_approval needs a message: what you ask to be approved." };
  if (words.length > MAX_APPROVAL_MESSAGE) return { error: `The message is too long to show whole (at most ${MAX_APPROVAL_MESSAGE} characters): shorten it.` };
  // A proposal's id goes with the question: the server then asks for that proposal's listed writes.
  if (proposal !== undefined && (typeof proposal !== "string" || !PROPOSAL_ID.test(proposal)))
    return { error: "proposal must be the id propose gave you; leave it out to ask in words only." };
  return { message: words, ...(proposal === undefined ? {} : { proposal }) };
}
