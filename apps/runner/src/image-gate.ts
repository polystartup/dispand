import type { HarnessEvent, RunnerToServer, ServerToRunner } from "@dispand/runner-protocol";

/**
 * The supervisor image names its worker image by digest (`DISPAND_WORKER_IMAGE`, set in
 * `apps/runner/Dockerfile`, never by the server). Set, the runner is the container supervisor;
 * unset, it is the bare install, which keeps running sessions on the machine as before.
 */
export function workerImage(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const image = env.DISPAND_WORKER_IMAGE;
  if (!image) return undefined;
  if (!/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(image)) throw new Error(`DISPAND_WORKER_IMAGE ${image} must name the worker image by digest (…@sha256:<hex>)`);
  return image;
}

export const SANDBOX_PENDING = "this runner image starts no session, CLI or tool until its sandbox is available";

/**
 * Whether each server message can start a process (a CLI, a plugin server, Skillshare). Typed
 * over every message, so a new one doesn't compile until it is classified here.
 */
const LAUNCHES = {
  "commands.request": true,
  "models.request": true,
  "plugin.request": true,
  "session.start": true,
  "tool.discover": true,
  "tool.call": true,
  "session.permissions": false,
  "session.send": false,
  "session.answer": false,
  "session.interrupt": false,
  "session.stop": false,
  ack: false,
} as const satisfies Record<ServerToRunner["type"], boolean>;

type Reply = Extract<RunnerToServer, { type: "tool.discovered" | "tool.called" | "plugin.replied" | "models.replied" | "commands.replied" }>;
type Refusal = { reply: Reply } | { sessionId: string; event: HarnessEvent };

/**
 * The image's answer to a message that would start a process, until its sandbox exists; the
 * others (a stop or message for a session that isn't running) go on to `Sessions`, which says so.
 */
export function refuseLaunch(msg: ServerToRunner): Refusal | undefined {
  if (!LAUNCHES[msg.type]) return undefined;
  const error = SANDBOX_PENDING;
  switch (msg.type) {
    case "session.start": return { sessionId: msg.start.sessionId, event: { type: "error", message: error } };
    case "commands.request": return { reply: { type: "commands.replied", requestId: msg.requestId, error } };
    case "models.request": return { reply: { type: "models.replied", requestId: msg.requestId, error } };
    case "plugin.request": return { reply: { type: "plugin.replied", requestId: msg.requestId, report: { error } } };
    case "tool.discover": return { reply: { type: "tool.discovered", requestId: msg.requestId, error } };
    case "tool.call": return { reply: { type: "tool.called", requestId: msg.requestId, error } };
    default: throw new Error(`no refusal for ${msg.type}`);
  }
}
