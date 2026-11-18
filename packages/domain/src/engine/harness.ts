import type { Db } from "../db/client.ts";
import type { Answer, ClaudeSessionStart, SessionStart } from "@dispand/runner-protocol";
import type { AnsweredBy, MessageFile } from "../db/schema.ts";
import type { CloudKind } from "../harnesses/cloud.ts";
import type { JobMemory } from "../memory/read.ts";

export type AgentAnswerer = Extract<AnsweredBy, { type: "agent" }>;
export type InterruptOutcome = "requested" | "stale" | "failed";

/** A CLI harness as a session needs it (a snapshot of the `harnesses` row). Sessions always run in a per-run folder. */
export type CliHarness = {
  [K in SessionStart["harness"]]: {
    id: string;
    runnerId: string;
    kind: K;
    permissionMode: Extract<SessionStart, { harness: K }>["permissionMode"];
    model?: string;
  };
}[SessionStart["harness"]];

/**
 * A cloud harness as a session needs it: no key (it is opened at each model call) and no
 * settings (read at each call too). `model` is the agent's own, when it overrides the harness's.
 */
export type CloudHarness = { id: string; type: "cloud"; kind: CloudKind; model?: string };

export type Harness = CliHarness | CloudHarness;

/** The `runnerId` of cloud step runs: their events come from the in-process `CloudRunner`. */
export const CLOUD_SOURCE = "cloud";

export function isCloud(h: Harness): h is CloudHarness {
  return "type" in h && h.type === "cloud";
}

/**
 * How a harness steers (`HarnessAdapter.steer`: a message joins the turn running now). Every
 * harness does, attachments included (a CLI gets them in its run folder before the text, a cloud
 * session with the message), and each says with `steer-result` once it took the message.
 * `interruptsTools`: steering stops the tools running in that turn. Claude Code takes a message at
 * once only by cutting its running turn (`priority: "now"`), and Dispand reports that and the turn
 * the CLI starts for it as one. Codex takes it beside them (`turn/steer`), a cloud session at its
 * next model call.
 */
export type Steering = { interruptsTools: boolean };

export function steering(h: Harness): Steering {
  return { interruptsTools: !isCloud(h) && h.kind === "claude-code" };
}

/**
 * What the engine decides about a session; the harness adds where and how it runs. `runKey` names a per-run directory.
 * Skills and MCP servers aren't sent yet: every start carries none.
 */
export type StartParams = Omit<ClaudeSessionStart, "harness" | "cwd" | "permissionMode" | "model" | "skills" | "mcpServers" | "memory"> & {
  runKey: string;
  /**
   * A Job's memory as read for this start, for a runner session only: the harness sends it as
   * files within what the start's frame leaves. Never stored with the step.
   */
  jobMemory?: JobMemory;
  /** The agents a Job's session may consult (its `consult` tool), as they were when it started; absent when none. */
  consults?: ConsultTarget[];
  /** A Job limited to some tools of Dispand's (a Stem Job): it runs only where nothing else is offered, a cloud harness. */
  restricted?: true;
};

/** An agent a session may consult: its id (what the tool takes), and its name and description as the asker reads them. */
export type ConsultTarget = { agentId: string; name: string; description: string };

/**
 * How the engine drives a harness (spec 5.1). Each call resolves true once the message reached
 * the harness (for a runner: the hub wrote it to the socket), false when it couldn't (the runner
 * is offline or catching up). Nothing is queued: the engine resends what wasn't delivered when
 * the runner is back (`Engine.reconcile`).
 */
export interface HarnessAdapter<H extends Harness = Harness> {
  start(harness: H, start: StartParams): Promise<boolean>;
  /** `files`: what the person attached to this chat message, attachments of the session's Job. */
  send(sessionId: string, text: string, files?: MessageFile[]): Promise<boolean>;
  /**
   * Sends a message that joins turn `turnId` while it runs, as `steering` says;
   * otherwise it goes like `send`, once either way. A `steer-result` event with `requestId` then
   * says whether it joined the turn (`steered`) or went as the next message (`queued`).
   */
  steer?(sessionId: string, turnId: string, requestId: string, text: string, files?: MessageFile[]): Promise<boolean>;
  narrowPermissions?(sessionId: string, db?: Db): Promise<boolean>;
  /** `by`: the agent that gave it (`inbox`), which the session is told with the answer; none for a person's. */
  answer(sessionId: string, questionId: string, answer: Answer, by?: AgentAnswerer): Promise<boolean>;
  interrupt?(sessionId: string, turnId: string): Promise<InterruptOutcome>;
  /**
   * Ends the session now, whatever it is doing; true once the harness was told (or has no such
   * session). `source` is where it runs (a runner id, or `CLOUD_SOURCE`): its step may be gone.
   */
  stop(sessionId: string, source: string): Promise<boolean>;
}
