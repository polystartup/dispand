// What Dispand hears of a session that failed on this runner: a sentence that holds nothing of
// this machine (no path, command line, argument list or process output), chosen by what failed.
// The error itself is logged here, where the machine's owner reads it.
import type { HarnessEvent } from "@dispand/runner-protocol";
import { NothingToResume, WorkdirRefused } from "./workdir.ts";

/**
 * A refusal whose words are written for the owner: they name only what Dispand sent (a tool, a
 * plugin, a package, a digest), never a path, command line or output of this machine. Its words
 * reach Dispand as they are; any other error reaches it only as its kind's sentence.
 */
export class Told extends Error {}

/** Where a session failed, each with its sentence. */
const SENTENCES = {
  /** Preparing it: its folder, files, worker or tools. */
  start: "the session couldn't start on this runner",
  /** Its Claude Code process, once started. */
  claude: "Claude Code stopped with an error",
  /** Its Codex app-server, once started. */
  codex: "Codex stopped with an error",
  /** A message Codex didn't take as a turn. */
  turn: "Codex didn't take the message",
} as const;
export type FailureKind = keyof typeof SENTENCES;

const WHY = "the runner's log says why";

/** The `error` event for `err`, a failure of `kind` in session `sessionId`; its words go to this runner's log only. */
export function failure(kind: FailureKind, err: unknown, sessionId: string): Extract<HarnessEvent, { type: "error" }> {
  const detail = err instanceof Error ? err.message : String(err);
  if (err instanceof Told) return { type: "error", message: err.message };
  const sentence =
    err instanceof NothingToResume
      ? "can't resume: this runner no longer has the run's folder"
      : err instanceof WorkdirRefused
        ? "the run's folder can't be used on this runner"
        : SENTENCES[kind];
  console.error(`dispand-runner: session ${sessionId}: ${sentence}:`, detail);
  return { type: "error", ...(err instanceof NothingToResume ? { kind: "cannot-resume" as const } : {}), message: `${sentence}: ${WHY}` };
}
