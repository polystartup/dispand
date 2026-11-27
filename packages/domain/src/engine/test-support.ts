// Test support: one fake harness for the domain's tests. Each member takes its type from
// `HarnessAdapter` and records into fields typed by hand, so a member added there, removed, or
// given other parameters or results fails here.
import type { Answer, Grant } from "@dispand/runner-protocol";
import type { Db } from "../db/client.ts";
import type { MessageFile } from "../db/schema.ts";
import type { AgentAnswerer, Harness, HarnessAdapter, InterruptOutcome, StartParams } from "./harness.ts";

type Members = Required<HarnessAdapter>;
/** The members the engine calls only on a harness that has them. */
type Optional = { [K in keyof HarnessAdapter]-?: undefined extends HarnessAdapter[K] ? K : never }[keyof HarnessAdapter];

/**
 * The adapter's members as this fake was written for them. Typing a member `Members[K]` alone
 * would still take a parameter added at the end, unread: each must be exactly as written here.
 */
type Written = {
  start: (harness: Harness, start: StartParams, grant?: Grant) => Promise<string | boolean>;
  send: (sessionId: string, text: string, files?: MessageFile[]) => Promise<boolean>;
  steer: (sessionId: string, turnId: string, requestId: string, text: string, files?: MessageFile[]) => Promise<boolean>;
  narrowPermissions: (sessionId: string, db?: Db) => Promise<boolean>;
  answer: (sessionId: string, questionId: string, answer: Answer, by?: AgentAnswerer) => Promise<boolean>;
  interrupt: (sessionId: string, turnId: string) => Promise<InterruptOutcome>;
  stop: (sessionId: string, source: string) => Promise<boolean>;
};
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
// Fails to compile when a member of the adapter's differs from `Written`, or is added or removed.
export const writtenFor: { [K in keyof Members | keyof Written]: K extends keyof Members & keyof Written ? Exact<Members[K], Written[K]> : never } = {
  start: true,
  send: true,
  steer: true,
  narrowPermissions: true,
  answer: true,
  interrupt: true,
  stop: true,
};

/**
 * Records what reaches the harness. It has an optional member only when its test asks
 * (`new FakeAdapter(["steer"])`): the engine sends a steer as a message to a harness without
 * `steer`, and counts an interrupt it can't make as failed.
 */
export class FakeAdapter implements HarnessAdapter {
  /** Each start: its harness, what it starts, and the personal grant it carries, if any. */
  starts: { harness: Harness; start: StartParams; grant?: Grant }[] = [];
  /** Each message: session, text. */
  sent: [string, string][] = [];
  /** Each steer: session, turn, request id (the queued item's), text. */
  steers: [string, string, string, string][] = [];
  /** Each answer: session, runner question id, answer. */
  answers: [string, string, Answer][] = [];
  /** Each interrupt: session, turn. */
  interrupts: [string, string][] = [];
  /** Each stop's session, and where it runs. */
  stops: string[] = [];
  stopSources: string[] = [];
  /** What reached the runner, in order: `start:<session>` once written, `send:<session>`. */
  log: string[] = [];

  /** False: the runner is away, and every call resolves false (an interrupt "failed"). */
  online = true;
  /** While set, starts don't settle until it does (a write still under way). */
  hold: Promise<void> | undefined;
  /** How long a start takes to be written, in ms. */
  delay = 0;
  /** The runner's connection a start is written on, when it is (`reconcile`): none named, by default. */
  connection: string | undefined;
  /** While set, an answer's write waits for it: a slow runner. */
  slow: Promise<void> | undefined;
  /** What an interrupt resolves to while online. */
  interruptOutcome: InterruptOutcome = "requested";

  start: Members["start"] = async (harness, start, grant) => {
    this.starts.push({ harness, start, grant });
    const on = this.connection ?? true;
    if (this.hold) await this.hold;
    if (this.delay) await new Promise((resolve) => setTimeout(resolve, this.delay));
    this.log.push(`start:${start.sessionId}`);
    return this.online && on;
  };
  send: Members["send"] = async (sessionId, text) => {
    this.sent.push([sessionId, text]);
    this.log.push(`send:${sessionId}`);
    return this.online;
  };
  answer: Members["answer"] = async (sessionId, questionId, answer) => {
    this.answers.push([sessionId, questionId, answer]);
    if (this.slow) await this.slow;
    return this.online;
  };
  stop: Members["stop"] = async (sessionId, source) => {
    this.stops.push(sessionId);
    this.stopSources.push(source);
    return this.online;
  };
  declare steer?: Members["steer"];
  declare interrupt?: Members["interrupt"];
  declare narrowPermissions?: Members["narrowPermissions"];

  /** `has`: the optional members this fake has, none by default. */
  constructor(has: Optional[] = []) {
    // One for each optional member of the adapter's: one added there fails here until it has its own.
    const optional: Pick<Members, Optional> = {
      steer: async (sessionId, turnId, requestId, text) => {
        this.steers.push([sessionId, turnId, requestId, text]);
        return this.online;
      },
      interrupt: async (sessionId, turnId) => {
        this.interrupts.push([sessionId, turnId]);
        return this.online ? this.interruptOutcome : "failed";
      },
      narrowPermissions: async () => this.online,
    };
    for (const member of has) Object.assign(this, { [member]: optional[member] });
  }
}
