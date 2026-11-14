import { ORPCError, os } from "@orpc/server";
import type { Auth } from "../auth.ts";
import type { DataEvents } from "../data/events.ts";
import type { Db } from "../db/client.ts";
import type { Engine } from "../engine/engine.ts";
import type { RunnerHub } from "../runners/hub.ts";
import type { SecretBox } from "../secrets.ts";
import { annotate, meter, recordError, tracer } from "../telemetry/index.ts";
import type { ToolConnector } from "../tools/mcp.ts";
import type { PrimitiveDefinition } from "../plugins/definitions.ts";

/** What the web server gives every request. */
export type InitialContext = {
  db: Db;
  auth: Auth;
  hub: RunnerHub;
  /** The one-time code `auth.setup` requires. */
  setupCode: string;
  engine: Engine;
  /** Row and schema changes per table, for `rows.stream`. */
  dataEvents: DataEvents;
  /** Where attachment files live: `<filesDir>/<ownerId>/<attachmentId>`. */
  filesDir: string;
  /** Seals and opens secrets stored in the database (`secrets.ts`). */
  secrets: SecretBox;
  /** Development only (e2e fixtures): lets plugin marketplaces be `file://` Git URLs. Never set in production. */
  gitFileUrls?: boolean;
  /** Calls MCP servers over HTTP (`tools/mcp.ts`); in production, never Dispand's own addresses. */
  tools: ToolConnector;
  /** Where a trace is opened, with `{traceId}` in it (`DISPAND_TRACE_URL`): the Audit page links trace ids there. */
  traceUrl?: string;
  /** The clock schedules are computed from (tests set it); the system clock when absent. */
  now?: () => Date;
  /**
   * The Job a tool call is made for (`platform/call.ts`): the procedure then runs as the Job's
   * owner, without a session. Set only there, after the call was authorized: nothing built from
   * a request ever carries it.
   */
  job?: { runId: string; ownerId: string; agentId: string };
  /** Server-owned bindings of a reviewed agent grant; never built from request input. */
  approvedToolTargets?: { toolId: string; target: string }[];
  /**
   * The plugin's element a create makes (`plugins/setup.ts`): the row is the plugin's from its
   * insert, under this name in it. Server-owned; never built from request input.
   */
  pluginElement?: { pluginId: string; component: string; definition?: PrimitiveDefinition };
  /**
   * A write that holds only while one field still has this value (a Stem decision,
   * `plugins/resolve.ts`): the element's update checks it under its row lock and refuses with
   * CONFLICT otherwise. Server-owned; never built from request input.
   */
  expectField?: { field: string; value: unknown };
  headers: Headers;
  /** Headers the web server adds to the response (refreshed session cookies). */
  resHeaders: Headers;
};

/** What an authenticated procedure sees. */
export type Context = { db: Db; ownerId: string; secrets: SecretBox };

const procedures = tracer("rpc");
const durations = meter("rpc").histogram("dispand.rpc.duration", { unit: "ms", description: "How long a procedure took" });

/** What a procedure ended as: "ok", the code of the error it answered with, or "error". */
const resultOf = (err: unknown) => (err instanceof ORPCError ? err.code : "error");

/**
 * Every procedure in a span named after it, called from a request or by a Job's tool alike: its
 * path and how it ended, never its input or its output. The owner is added once known (`authed`).
 */
const traced = os.$context<InitialContext>().middleware(({ path, next }) => {
  // A call in process (a test) may name no path.
  const method = path.join(".") || "rpc";
  const started = performance.now();
  return procedures.startActiveSpan(method, { attributes: { "rpc.method": method } }, async (span) => {
    let result = "ok";
    try {
      return await next();
    } catch (err) {
      result = resultOf(err);
      recordError(span, result);
      throw err;
    } finally {
      span.setAttribute("dispand.result", result);
      span.end();
      durations.record(performance.now() - started, { "rpc.method": method, "dispand.result": result });
    }
  });
});

export const base = os.$context<InitialContext>().use(traced);

/** Rejects requests without a session and hands the owner id to the procedure. */
export const authed = os.$context<InitialContext>().middleware(async ({ context, next }) => {
  if (context.job) {
    annotate({ "dispand.owner.id": context.job.ownerId, "dispand.job.id": context.job.runId });
    return next({ context: { ownerId: context.job.ownerId } satisfies Pick<Context, "ownerId"> });
  }
  const { headers, response: session } = await context.auth.api.getSession({
    headers: context.headers,
    returnHeaders: true,
  });
  for (const cookie of headers.getSetCookie()) context.resHeaders.append("set-cookie", cookie);
  if (!session) throw new ORPCError("UNAUTHORIZED");
  annotate({ "dispand.owner.id": session.user.id });
  return next({ context: { ownerId: session.user.id } satisfies Pick<Context, "ownerId"> });
});
