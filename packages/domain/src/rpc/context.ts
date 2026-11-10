import { ORPCError, os } from "@orpc/server";
import type { Auth } from "../auth.ts";
import type { DataEvents } from "../data/events.ts";
import type { Db } from "../db/client.ts";
import type { Engine } from "../engine/engine.ts";
import type { RunnerHub } from "../runners/hub.ts";
import type { SecretBox } from "../secrets.ts";
import type { ToolConnector } from "../tools/mcp.ts";

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
  /** The clock schedules are computed from (tests set it); the system clock when absent. */
  now?: () => Date;
  /**
   * The Job a tool call is made for (`platform/call.ts`): the procedure then runs as the Job's
   * owner, without a session. Set only there, after the call was authorized: nothing built from
   * a request ever carries it.
   */
  job?: { runId: string; ownerId: string; agentId: string };
  headers: Headers;
  /** Headers the web server adds to the response (refreshed session cookies). */
  resHeaders: Headers;
};

/** What an authenticated procedure sees. */
export type Context = { db: Db; ownerId: string; secrets: SecretBox };

export const base = os.$context<InitialContext>();

/** Rejects requests without a session and hands the owner id to the procedure. */
export const authed = base.middleware(async ({ context, next }) => {
  if (context.job) return next({ context: { ownerId: context.job.ownerId } satisfies Pick<Context, "ownerId"> });
  const { headers, response: session } = await context.auth.api.getSession({
    headers: context.headers,
    returnHeaders: true,
  });
  for (const cookie of headers.getSetCookie()) context.resHeaders.append("set-cookie", cookie);
  if (!session) throw new ORPCError("UNAUTHORIZED");
  return next({ context: { ownerId: session.user.id } satisfies Pick<Context, "ownerId"> });
});
