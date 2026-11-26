import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Db } from "@dispand/domain";
import { upgradeRunner } from "@dispand/domain/upgrade";
import { MAX_RESULT_BODY_BYTES } from "@dispand/runner-protocol";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { serve as listen, type Server } from "srvx";
import { staticMiddleware } from "srvx/static";

// For the production entry, which reads its settings through the bundle like the rest of the server.
export { loadServerConfig } from "./server/config.ts";
import { withPageSecurity } from "./server/page-security.ts";
import type { App, BuildOptions } from "./server/app.ts";
import type { ServerConfig } from "./server/config.ts";

export type { App, BuildOptions, ServerConfig };

/**
 * Every upgrade comes here (see `serve`). The hub comes from
 * `getApp()`, so it is the one the routes use; `app.ts` is imported lazily, like the routes do,
 * because it finds the migrations relative to its own chunk in `dist/server/assets`.
 */
function handleRunnerUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  upgradeRunner(req, socket, head, async () => (await (await import("./server/app.ts")).getApp()).hub);
}

async function closeRunnerHub(): Promise<void> {
  await (await import("./server/app.ts")).closeHub();
}

/**
 * For another entry with its own database and startup (`server/app.ts`): it starts telemetry
 * (`startTelemetry`) before opening its database, builds the app around that open, migrated
 * database, starts it (or runs its own steps), and supplies it with `setApp` before taking requests.
 */
export async function buildApp(db: Db, config: ServerConfig, options?: BuildOptions): Promise<App> {
  return (await import("./server/app.ts")).buildApp(db, config, options);
}

export async function startApp(app: App): Promise<void> {
  await (await import("./server/app.ts")).startApp(app);
}

export async function setApp(app: App | Promise<App>): Promise<void> {
  (await import("./server/app.ts")).setApp(app);
}

/** Called on shutdown (see `serve`), after the runners' connections: the database. */
export async function closeApp(): Promise<void> {
  await (await import("./server/app.ts")).closeApp();
}

// No request needs more than 1 MiB but an upload (`files.upload` and `files.hold`, 10 MiB of file plus multipart
// overhead; `skills.create` and `skills.update`, 8 MiB of files in base64) and a runner tool's
// result (`/mcp/job/files`, up to 20 files of 10 MiB in base64, kept or refused whole): the API
// and auth take small JSON bodies. A body announced larger than its path's cap
// gets a 413 at once, and one without a length (chunked) a 411, so no body runs past its cap;
// browsers and the runner always send the length. `/runner/pair` reads at most 1 KiB itself.
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_UPLOAD_BODY_BYTES = 11 * 1024 * 1024;
const UPLOAD_PATHS = new Set(["/api/rpc/files/upload", "/api/rpc/files/hold", "/api/rpc/skills/create", "/api/rpc/skills/update"]);
const capOf = (request: Request) => {
  const path = URL.parse(request.url)?.pathname ?? "";
  return path === "/mcp/job/files" ? MAX_RESULT_BODY_BYTES : UPLOAD_PATHS.has(path) ? MAX_UPLOAD_BODY_BYTES : MAX_REQUEST_BODY_BYTES;
};
const refuseLargeBodies = (request: Request, next: () => Response | Promise<Response>) => {
  if (request.headers.has("transfer-encoding") && !request.headers.has("content-length")) return new Response(null, { status: 411 });
  return Number(request.headers.get("content-length") ?? 0) > capOf(request) ? new Response(null, { status: 413 }) : next();
};

/**
 * Listens on `config.port` and `config.host`: the built client files, the app's routes and the
 * runner hub's WebSocket upgrade on `/runner/ws`, with per-path body caps. `app` is the entry's own
 * (built and started, see `buildApp`), supplied with `setApp`; without one, the server opens,
 * migrates and starts its own on first use. On SIGINT or SIGTERM it closes the runners' sockets,
 * the server, then the app, and exits.
 */
export async function serve(app: App | Promise<App> | undefined, config: ServerConfig): Promise<Server> {
  // A failed start fails here, before listening.
  if (app) await setApp(await app);
  const server = listen({
    port: config.port,
    hostname: config.host,
    maxRequestBodySize: MAX_RESULT_BODY_BYTES,
    // Stopped below, together with the runner sockets and the database.
    gracefulShutdown: false,
    // The client files are next to this bundle's directory (`dist/server` and `dist/client`).
    middleware: [refuseLargeBodies, staticMiddleware({ dir: fileURLToPath(new URL("../client", import.meta.url)) })],
    fetch: entry.fetch,
  });
  await server.ready();

  // Every upgrade goes to the hub's guarded entry, which refuses what isn't `/runner/ws`.
  server.node?.server?.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => handleRunnerUpgrade(req, socket, head));

  // Open runner WebSockets and the database's connections (a pool's idle sockets, PGlite's timer)
  // would keep the process alive after the server stops: close them too, runner sockets first.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void (async () => {
        // Upgraded WebSockets are not closed by the HTTP server: close the runners' first.
        await closeRunnerHub();
        // Requests in progress get up to 5 s to finish; then the rest (long-lived streams) are cut.
        const closed = server.close();
        const drained = await Promise.race([closed.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000))]);
        if (!drained) {
          const http = server.node?.server;
          if (http && "closeAllConnections" in http) http.closeAllConnections();
          await closed;
        }
        await closeApp();
        process.exit(0);
      })();
    });
  }
  return server;
}

const entry = createServerEntry({ fetch: async (...args) => withPageSecurity(await handler.fetch(...args)) });
export default entry;
