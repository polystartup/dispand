import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { upgradeRunner } from "@dispand/domain/upgrade";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

// For the production entry, which reads its settings through the bundle like the rest of the server.
export { loadServerConfig } from "./server/config.ts";

/**
 * The production entry (`server.ts` at the app root) hands every upgrade here. The hub comes from
 * `getApp()`, so it is the one the routes use; `app.ts` is imported lazily, like the routes do,
 * because it finds the migrations relative to its own chunk in `dist/server/assets`.
 */
export function handleRunnerUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  upgradeRunner(req, socket, head, async () => (await (await import("./server/app.ts")).getApp()).hub);
}

/** Called by the production entry on SIGTERM/SIGINT. */
export async function closeRunnerHub(): Promise<void> {
  await (await import("./server/app.ts")).closeHub();
}

/** Called by the production entry on shutdown, after the runners' connections: the database. */
export async function closeApp(): Promise<void> {
  await (await import("./server/app.ts")).closeApp();
}

export default createServerEntry({ fetch: handler.fetch });
