import type { Answer, ClaudeSessionStart, SessionStart } from "@dispand/runner-protocol";
import type { AnsweredBy } from "../db/schema.ts";
import type { CloudKind } from "../harnesses/cloud.ts";

export type AgentAnswerer = Extract<AnsweredBy, { type: "agent" }>;

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
 * What the engine decides about a session; the harness adds where and how it runs. `runKey` names a per-run directory.
 * Skills and MCP servers aren't sent yet: every start carries none.
 */
export type StartParams = Omit<ClaudeSessionStart, "harness" | "cwd" | "permissionMode" | "model" | "skills" | "mcpServers"> & {
  runKey: string;
  /** The agents a Job's cloud session may consult (its `consult` tool), as they were when it started; absent when none. */
  consults?: ConsultTarget[];
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
  send(sessionId: string, text: string): Promise<boolean>;
  /** `by`: the agent that gave it (`inbox`), which the session is told with the answer; none for a person's. */
  answer(sessionId: string, questionId: string, answer: Answer, by?: AgentAnswerer): Promise<boolean>;
  /**
   * Ends the session now, whatever it is doing; true once the harness was told (or has no such
   * session). `source` is where it runs (a runner id, or `CLOUD_SOURCE`): its step may be gone.
   */
  stop(sessionId: string, source: string): Promise<boolean>;
}
