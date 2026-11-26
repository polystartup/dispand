/**
 * What the engine is about to do on a step's place: start or resume its session (`launch`,
 * `resume`), do what a slot was handed for (`handOver`), take a slot for held work (`wake`), send
 * its answers and chat messages (`flush`, `answer`, `message`), decide on it as its runner reports
 * (`reconcile`), call its Tool step's tool (`tool`), or fail a Tool step left running (`failTool`).
 */
export type PlaceWork = "launch" | "resume" | "handOver" | "wake" | "flush" | "answer" | "message" | "reconcile" | "tool" | "failTool";

/** The step whose place it is: its session, once it has one (a Tool step has none). */
export type Place = { stepId: string; sessionId: string | null };

/**
 * Asked before the engine works on a step's place: the runner connection its session is on, its
 * cloud session, its Tool step's call. A process that embeds Dispand beside others sharing its
 * database admits the work where it holds the place and refuses it elsewhere. A refusal writes
 * nothing: what the work would have sent stays owed in its rows, for the place's holder to send.
 * Without a gate the engine asks nothing, so every place is its own and each path runs as it
 * would with no gate at all.
 */
export interface PlaceGate {
  admits(work: PlaceWork, place: Place): boolean | Promise<boolean>;
}
