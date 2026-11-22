import { ORPCError, os, ValidationError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { requireLegacyScope } from "../workspace/access.ts";
import { inScope } from "../db/scope.ts";
import { type Access, authorize, ORGANIZATION_HEADER, ownsOrganization, resolveWorkspace } from "../workspace/authorize.ts";
import { runs, workspaces } from "../db/schema.ts";
import type { Auth } from "../auth.ts";
import type { DataEvents } from "../data/events.ts";
import type { Db } from "../db/client.ts";
import type { Engine } from "../engine/engine.ts";
import { logError } from "../log.ts";
import { external, isMessageKey, type Message, message, type MessageValues } from "../messages/index.ts";
import type { RunnerHub } from "../runners/hub.ts";
import type { SecretBox } from "../secrets.ts";
import { annotate, meter, recordError, tracer } from "../telemetry/index.ts";
import type { ToolConnector } from "../tools/mcp.ts";
import type { PrimitiveDefinition } from "../plugins/definitions.ts";

/** What the web server gives every request. */
export type InitialContext = {
  db: Db;
  /** Better Auth's tables (`user`, `account`, `session`, `verification`): `db` itself, or another login on it. */
  authDb: Db;
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
  approvedToolTargets?: { toolId: string; target: string; strictTarget?: string }[];
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
      // The page gets only "Internal server error" (oRPC hides the rest): its summary goes to the logs.
      if (!(err instanceof ORPCError)) logError("procedure failed", err);
      throw err;
    } finally {
      span.setAttribute("dispand.result", result);
      span.end();
      durations.record(performance.now() - started, { "rpc.method": method, "dispand.result": result });
    }
  });
});

/** Zod's issue, as oRPC's ValidationError carries it (`issues` are Zod's own). */
type Issue = { code: string; message?: string; path: PropertyKey[]; origin?: string; minimum?: unknown; maximum?: unknown; divisor?: unknown; keys?: string[]; values?: unknown[]; params?: MessageValues };

/** An input its schema rejected, as the message of its first issue: `validation.<code>`, the field's path and limits as values. */
export function validationKey(issue: Issue): Message {
  const field = issue.path.map(String).join(".") || "input";
  const limit = (bound: unknown) => (typeof bound === "bigint" ? Number(bound) : typeof bound === "number" ? bound : String(bound));
  switch (issue.code) {
    case "too_small":
    case "too_big": {
      const bound = limit(issue.code === "too_small" ? issue.minimum : issue.maximum);
      const of = issue.origin === "string" ? "string" : issue.origin === "array" || issue.origin === "set" ? "array" : "number";
      if (of !== "number") return { key: `validation.${issue.code}.${of}`, values: { field, count: bound } };
      return { key: `validation.${issue.code}.number`, values: issue.code === "too_small" ? { field, minimum: bound } : { field, maximum: bound } };
    }
    case "not_multiple_of":
      return { key: "validation.not_multiple_of", values: { field, divisor: limit(issue.divisor) } };
    case "unrecognized_keys":
      return { key: "validation.unrecognized_keys", values: { field, keys: (issue.keys ?? []).join(", ") } };
    case "invalid_value":
      return { key: "validation.invalid_value", values: { field, values: (issue.values ?? []).map(String).join(", ") } };
    case "invalid_type":
    case "invalid_format":
    case "invalid_union":
    case "invalid_key":
    case "invalid_element":
      return { key: `validation.${issue.code}`, values: { field } };
    default:
      return { key: "validation.custom", values: { field } };
  }
}

/** A rejected input answers with the keyed message of its first issue, in every language the page speaks. */
const validation = os.$context<InitialContext>().middleware(async ({ next }) => {
  try {
    return await next();
  } catch (err) {
    const cause: unknown = err instanceof ORPCError && err.code === "BAD_REQUEST" ? err.cause : undefined;
    const issue = cause instanceof ValidationError ? (cause.issues[0] as Issue | undefined) : undefined;
    if (!issue) throw err;
    // A refinement's own message (a key, or words of an area not yet keyed) is kept; zod's default is not one.
    if (issue.code === "custom" && issue.message && issue.message !== "Invalid input") {
      if (isMessageKey(issue.message)) throw new ORPCError("BAD_REQUEST", message(issue.message, issue.params));
      throw new ORPCError("BAD_REQUEST", external(issue.message));
    }
    const { key, values } = validationKey(issue);
    throw new ORPCError("BAD_REQUEST", message(key, values));
  }
});

export const base = os.$context<InitialContext>().use(traced).use(validation);

/** Resolves a session or trusted Job identity. Each scoped procedure checks its own resource. */
export const signedIn = os.$context<InitialContext>().middleware(async ({ context, next }) => {
  if (context.job) {
    annotate({ "dispand.owner.id": context.job.ownerId, "dispand.job.id": context.job.runId });
    const ownerId = context.job.ownerId;
    return inScope({ userId: ownerId }, () => next({ context: { ownerId } satisfies Pick<Context, "ownerId"> }));
  }
  const { headers, response: session } = await context.auth.api.getSession({
    headers: context.headers,
    returnHeaders: true,
  });
  for (const cookie of headers.getSetCookie()) context.resHeaders.append("set-cookie", cookie);
  if (!session) throw new ORPCError("UNAUTHORIZED", message("auth.signIn"));
  annotate({ "dispand.owner.id": session.user.id });
  // A person alone: their own memberships, until a middleware below admits them to a workspace.
  const ownerId = session.user.id;
  return inScope({ userId: ownerId }, () => next({ context: { ownerId } satisfies Pick<Context, "ownerId"> }));
});

/** Procedures that still address data by owner require the original self-hosted access boundary. */
export const authed = signedIn.concat(async ({ context, next }) => {
  const scope = await requireLegacyScope(context);
  return inScope({ userId: context.ownerId, ...scope }, () => next());
});

const noWorkspace = () => new ORPCError("NOT_FOUND", message("workspace.membershipNotFound"));

/**
 * Admits a person with a role in the workspace the request names (`resolveWorkspace`), read live
 * on every call. A Job is admitted in its run's workspace as a member, whatever the request says.
 */
export const member = signedIn.concat(async ({ context, next }) => {
  if (context.job) {
    const [run] = await context.db.select({ organizationId: workspaces.organizationId, workspaceId: runs.workspaceId }).from(runs)
      .innerJoin(workspaces, eq(workspaces.id, runs.workspaceId))
      .where(and(eq(runs.id, context.job.runId), eq(runs.ownerId, context.job.ownerId)));
    if (!run) throw noWorkspace();
    return inScope({ userId: context.ownerId, ...run }, () => next({ context: { access: { ...run, userId: context.ownerId, role: "member" } satisfies Access } }));
  }
  const named = await resolveWorkspace(context.db, context.ownerId, context.headers);
  const role = named && (await authorize(context.db, context.ownerId, named.organizationId, named.workspaceId));
  if (!named || !role) throw noWorkspace();
  return inScope({ userId: context.ownerId, ...named }, () => next({ context: { access: { ...named, userId: context.ownerId, role } satisfies Access } }));
});

/** A member who manages the workspace: its manager or the organization's owner. Never a Job. */
export const manager = member.concat(async ({ context, next }) => {
  if (context.access.role === "member") throw new ORPCError("FORBIDDEN", message("workspace.membershipNotFound"));
  return next();
});

/** The owner of the organization the request names, read live. Never a Job. */
export const orgOwner = signedIn.concat(async ({ context, next }) => {
  const organizationId = context.headers.get(ORGANIZATION_HEADER);
  if (context.job || !organizationId || !(await ownsOrganization(context.db, context.ownerId, organizationId))) throw noWorkspace();
  return inScope({ userId: context.ownerId, organizationId }, () => next({ context: { access: { organizationId, userId: context.ownerId, role: "owner" as const } } }));
});
