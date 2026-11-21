import { type message, type Message, stored } from "../messages/index.ts";

/** Why a Tool step that was calling its tool when Dispand stopped fails (it is never called again). */
export const TOOL_RESTARTED = stored("engine.fail.toolRestarted");

/** Why the steps of a run stopped by hand failed, and the run with them. */
export const STOPPED = stored("engine.fail.stopped");
/** Whether the run was stopped by hand rather than failing by itself: its error says so (no column does). */
export const stoppedByHand = (run: { error: string | null }) => run.error === STOPPED;

/** Why a step fails when its agent's runner was revoked. */
export const RUNNER_REVOKED = stored("engine.fail.runnerRevoked");

export class EngineError extends Error {
  override name = "EngineError";
  /** What the page translates, when its text reaches a person (`message()`). */
  readonly data: Message;
  constructor(
    readonly code: "NOT_FOUND" | "INVALID" | "CLOSED" | "NOT_PENDING" | "STOPPED",
    detail: ReturnType<typeof message>,
  ) {
    super(detail.message);
    this.data = detail.data;
  }
}

/** A keyed engine error's options, passed on as a procedure's error: `new ORPCError(code, passOn(err))`. */
export const passOn = (err: EngineError) => ({ message: err.message, data: err.data });
