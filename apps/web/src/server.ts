import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Db } from "@dispand/domain";
import { upgradeRunner } from "@dispand/domain/upgrade";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

// For the production entry, which reads its settings through the bundle like the rest of the server.
export { loadServerConfig } from "./server/config.ts";
/** The body cap of the runner tools' files endpoint, for `server.ts`'s per-path caps. */
export { MAX_RESULT_BODY_BYTES } from "@dispand/runner-protocol";
import { withPageSecurity } from "./server/page-security.ts";
import type { App } from "./server/app.ts";
import type { ServerConfig } from "./server/config.ts";

export type { App };

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

/**
 * For another entry with its own database and startup (`server/app.ts`): it starts telemetry
 * (`startTelemetry`) before opening its database, builds the app around that open, migrated
 * database, starts it (or runs its own steps), and supplies it with `setApp` before taking requests.
 */
export async function buildApp(db: Db, config: ServerConfig): Promise<App> {
  return (await import("./server/app.ts")).buildApp(db, config);
}

export async function startApp(app: App): Promise<void> {
  await (await import("./server/app.ts")).startApp(app);
}

export async function setApp(app: App | Promise<App>): Promise<void> {
  (await import("./server/app.ts")).setApp(app);
}

/** Called by the production entry on shutdown, after the runners' connections: the database. */
export async function closeApp(): Promise<void> {
  await (await import("./server/app.ts")).closeApp();
}

export default createServerEntry({ fetch: async (...args) => withPageSecurity(await handler.fetch(...args)) });
