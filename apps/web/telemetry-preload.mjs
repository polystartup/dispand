// Loaded before anything else (`node --import ./telemetry-preload.mjs`, and the dev server's
// NODE_OPTIONS): the HTTP server, the PostgreSQL driver and outbound fetch are instrumented only
// if they are hooked before they load. The spans go through the providers `startTelemetry`
// sets later, and through its redaction (`packages/domain/src/telemetry/`): nothing here sends
// anything. No header is recorded, and the requests `telemetry-requests.mjs` lists make no span.
import { register } from "node:module";
import { ignoredIncoming, ignoredOutgoing } from "./telemetry-requests.mjs";

// Only the modules instrumented below are wrapped: wrapping every module breaks libraries whose
// modules import each other in a cycle (the router's own).
register("@opentelemetry/instrumentation/hook.mjs", import.meta.url, { data: { include: ["pg", "http", "https", "node:http", "node:https"] } });

const { registerInstrumentations } = await import("@opentelemetry/instrumentation");
const { HttpInstrumentation } = await import("@opentelemetry/instrumentation-http");
const { PgInstrumentation } = await import("@opentelemetry/instrumentation-pg");
const { UndiciInstrumentation } = await import("@opentelemetry/instrumentation-undici");

const instrumentations = [
  new HttpInstrumentation({
    ignoreIncomingRequestHook: (request) => ignoredIncoming(request.url),
    ignoreOutgoingRequestHook: (options) => ignoredOutgoing(options.hostname ?? options.host, options.port),
    // The client is the one the reverse proxy saw (`X-Real-IP`, the only header it sets), never
    // what `Forwarded` or `X-Forwarded-For` claim.
    requestHook: (span, request) => {
      if (!("headers" in request) || !request.socket) return;
      const real = request.headers["x-real-ip"];
      span.setAttribute("client.address", typeof real === "string" && real ? real : (request.socket.remoteAddress ?? ""));
    },
  }),
    // Statements without their values: no `enhancedDatabaseReporting`, no hooks that read them.
  new PgInstrumentation({ enhancedDatabaseReporting: false }),
  new UndiciInstrumentation(),
];
registerInstrumentations({ instrumentations });
// Their metrics bind to the meter provider when they start, and there is none yet:
// `startTelemetry` gives them the real one through this.
globalThis[Symbol.for("dispand.instrumentations")] = instrumentations;
