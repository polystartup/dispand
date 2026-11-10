import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

// The dev Vite plugin loads this module in Vite's own process: import nothing but dependency-free modules.
import { logError } from "../log.ts";

export const RUNNER_WS_PATH = "/runner/ws";

/** The request target's path, or null when it doesn't parse (`//[`…). Never throws. */
export function upgradePath(req: IncomingMessage): string | null {
  try {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return null;
  }
}

/** Whether an upgrade is for the runner hub (Vite's server also gets its HMR upgrades). */
export function isRunnerUpgrade(req: IncomingMessage): boolean {
  return upgradePath(req) === RUNNER_WS_PATH;
}

const reasons = {
  400: "Bad Request",
  401: "Unauthorized",
  404: "Not Found",
  426: "Upgrade Required",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

/** Answers an upgrade with an HTTP error (and a plain-text `body`, if any) and closes the socket. */
export function refuseUpgrade(socket: Duplex, status: keyof typeof reasons, body = ""): void {
  if (socket.destroyed) return;
  const head = `HTTP/1.1 ${status} ${reasons[status]}\r\nConnection: close\r\n`;
  const type = body ? "Content-Type: text/plain; charset=utf-8\r\n" : "";
  socket.end(`${head}${type}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

/**
 * The one way an HTTP server hands an upgrade to the hub: entries call it synchronously with
 * the raw request, and nothing escapes it. The socket gets its error listener before anything
 * can wait (a reset in between would otherwise crash the process); `hub.handleUpgrade` does the
 * rest, under the same guard.
 */
export function upgradeRunner(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  loadHub: () => Promise<{ handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void }>,
): void {
  socket.on("error", () => socket.destroy());
  try {
    loadHub().then(
      (hub) => hub.handleUpgrade(req, socket, head),
      (err: unknown) => {
        logError("runner hub unavailable", err);
        refuseUpgrade(socket, 503);
      },
    );
  } catch (err) {
    logError("runner hub unavailable", err);
    refuseUpgrade(socket, 503);
  }
}
