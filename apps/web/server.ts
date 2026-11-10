// Production entry: `pnpm build`, then `node server.ts`. Serves the built client files, the
// TanStack Start handler, and the runner hub's WebSocket upgrade on `/runner/ws`.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { serve } from "srvx";
import { staticMiddleware } from "srvx/static";
import type { ServerConfig } from "./src/server/config.ts";

type Built = {
  default: { fetch: (request: Request) => Response | Promise<Response> };
  handleRunnerUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  loadServerConfig: () => ServerConfig;
  closeRunnerHub: () => Promise<void>;
  closeApp: () => Promise<void>;
};

const built = (await import(new URL("./dist/server/server.js", import.meta.url).href)) as Built;

// Fails fast on missing settings, before listening.
const config = built.loadServerConfig();

// No request needs more than 1 MiB but an upload (`files.upload`, 10 MiB of file plus multipart
// overhead; `skills.create` and `skills.update`, 8 MiB of files in base64): the API and auth take
// small JSON bodies. A body announced larger than its path's cap
// gets a 413 at once, and one without a length (chunked) a 411, so no body runs past its cap;
// browsers and the runner always send the length. `/runner/pair` reads at most 1 KiB itself.
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_UPLOAD_BODY_BYTES = 11 * 1024 * 1024;
const UPLOAD_PATHS = new Set(["/api/rpc/files/upload", "/api/rpc/skills/create", "/api/rpc/skills/update"]);
const capOf = (request: Request) => (UPLOAD_PATHS.has(URL.parse(request.url)?.pathname ?? "") ? MAX_UPLOAD_BODY_BYTES : MAX_REQUEST_BODY_BYTES);
const refuseLargeBodies = (request: Request, next: () => Response | Promise<Response>) => {
  if (request.headers.has("transfer-encoding") && !request.headers.has("content-length")) return new Response(null, { status: 411 });
  return Number(request.headers.get("content-length") ?? 0) > capOf(request) ? new Response(null, { status: 413 }) : next();
};

const server = serve({
  port: config.port,
  hostname: config.host,
  maxRequestBodySize: MAX_UPLOAD_BODY_BYTES,
  // Stopped below, together with the runner sockets and the database.
  gracefulShutdown: false,
  middleware: [refuseLargeBodies, staticMiddleware({ dir: new URL("./dist/client", import.meta.url).pathname })],
  fetch: built.default.fetch,
});
await server.ready();

// Every upgrade goes to the hub's guarded entry, which refuses what isn't `/runner/ws`.
server.node?.server?.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) =>
  built.handleRunnerUpgrade(req, socket, head),
);

// Open runner WebSockets and the database's connections (a pool's idle sockets, PGlite's timer)
// would keep the process alive after the server stops: close them too, runner sockets first.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (async () => {
      // Upgraded WebSockets are not closed by the HTTP server: close the runners' first.
      await built.closeRunnerHub();
      // Requests in progress get up to 5 s to finish; then the rest (long-lived streams) are cut.
      const closed = server.close();
      const drained = await Promise.race([closed.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000))]);
      if (!drained) {
        const http = server.node?.server;
        if (http && "closeAllConnections" in http) http.closeAllConnections();
        await closed;
      }
      await built.closeApp();
      process.exit(0);
    })();
  });
}
