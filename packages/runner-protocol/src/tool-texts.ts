import { TEXT } from "./bounds.ts";
import type { OutputField } from "./harness.ts";

// What Dispand's own tools and permission prompts answer the model: made here once, so a cloud
// session (`packages/domain/src/cloud`) and a runner's Claude Code and Codex sessions say the same.

/** The most `submit_outputs` hands back in all, as JSON: its values travel in one event (outputs-accepted, and confirm-outputs), well under the hub's 1 MiB frames. */
export const MAX_OUTPUTS_BYTES = 512 * 1024;

export const TOOL_TEXTS = {
  submitOutputsDescription: "Hand your results back to Dispand. Call it once you have every value.",
  missingOutputs: (names: string[]) => `Missing outputs: ${names.join(", ")}. Call submit_outputs again with every value, as text.`,
  outputsTooLarge: `The outputs are too large: at most ${TEXT} characters each and ${MAX_OUTPUTS_BYTES / 1024} KiB in all. Shorten them and call submit_outputs again.`,
  confirmed: "confirmed",
  notConfirmed: "The owner did not confirm these values.",
  reminder: (fields: OutputField[]) => `Call submit_outputs with: ${fields.map((f) => f.name).join(", ")}`,
  approved: "Approved.",
  /** A denied `request_approval`, with the owner's reason when they gave one. */
  deniedApproval: (reason?: string) => (reason ? `Denied: ${reason}` : "Denied."),
  /** What a tool called in the same turn as a denied `request_approval` gets back. */
  notRunAfterDenial: "Not run: the owner denied the approval you asked for in the same turn.",
  denied: "The owner denied this.",
  tooLargeToAsk: "The tool input is too large to show for approval (or holds characters that can't be shown): split it up.",
  questionsTooLong: "These questions are too long to tell apart once shown: shorten them and ask again.",
  notAnswered: "The question was not answered.",
  filesNotKept: "The call ran, but the files it returned couldn't be kept.",
};
