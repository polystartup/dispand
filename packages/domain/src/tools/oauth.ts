import { timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Auth } from "../auth.ts";
import type { Db } from "../db/client.ts";
import { tools as toolsTable } from "../db/schema.ts";
import { logError } from "../log.ts";
import type { SecretBox } from "../secrets.ts";
import { ToolError } from "./errors.ts";
import type { ToolConnector } from "./mcp.ts";
import { clientDocumentUrl, clientMetadata, type OAuthState } from "./oauth-provider.ts";
import { oauthStep, oauthStore, openState, sealState, stateHash } from "./oauth-store.ts";
import { refreshActions, toolTarget } from "./procedures.ts";

export type OAuthApp = { db: Db; auth: Auth; secrets: SecretBox; tools: ToolConnector };

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Takes the flow a callback's `state` names, among `ownerId`'s tools, and removes it: a flow is
 * used once, and only before it expires. Null for a `state` that names none.
 */
async function takeFlow(db: Db, secrets: SecretBox, ownerId: string, state: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(toolsTable)
      .where(and(eq(toolsTable.ownerId, ownerId), eq(toolsTable.oauthStateHash, stateHash(state)), eq(toolsTable.auth, "oauth")))
      .for("update");
    if (!row) return null;
    const sealed = openState(secrets, row.id, row.oauthSealed);
    const pending = sealed.pending;
    if (!pending || !same(pending.state, state)) return null;
    delete sealed.pending;
    await tx.update(toolsTable).set(sealState(secrets, row.id, sealed)).where(eq(toolsTable.id, row.id));
    return pending.expiresAt > Date.now() ? { row, pending: pending as NonNullable<OAuthState["pending"]> } : null;
  });
}

/**
 * The callback of a sign-in: compares `state` with the flow it started, hands the parameters to
 * the SDK (`finishAuth`: the issuer check and the code exchange with the flow's verifier), then
 * lists the tool's actions on a fresh connection. A failure is stored as the tool's `actionsError`,
 * a short reason made here.
 */
export async function finishToolAuthorization(app: Omit<OAuthApp, "auth">, ownerId: string, params: URLSearchParams): Promise<{ toolId?: string; ok: boolean }> {
  const state = params.get("state");
  const flow = state && state.length <= 200 ? await takeFlow(app.db, app.secrets, ownerId, state) : null;
  if (!flow) return { ok: false };
  const { row, pending } = flow;
  const fail = async (reason: string) => {
    await app.db.update(toolsTable).set({ actionsError: reason }).where(eq(toolsTable.id, row.id));
    return { toolId: row.id, ok: false };
  };
  if (params.has("error")) return fail("The sign-in was refused or cancelled: connect the tool again");
  try {
    await oauthStep("callback", row.id, () => app.tools.finishAuthorization({ ...toolTarget(row, app.secrets), oauth: oauthStore(app.db, app.secrets, row.id, ownerId) }, pending, params));
  } catch (error) {
    if (!(error instanceof ToolError)) logError("tools.oauth callback failed", error, { ref: row.id });
    return fail(error instanceof ToolError ? error.message : "The sign-in couldn't be finished: connect the tool again");
  }
  const [connected] = await app.db
    .update(toolsTable)
    .set({ oauthStatus: "connected", actionsError: null })
    .where(and(eq(toolsTable.id, row.id), eq(toolsTable.auth, "oauth")))
    .returning();
  // A fresh connection, with the tokens just saved.
  if (connected) await refreshActions(app.db, app.secrets, app.tools, connected).catch((error: unknown) => logError("tools.refresh failed", error, { ref: row.id }));
  return { toolId: row.id, ok: true };
}

/**
 * `GET /oauth/callback`: where the authorization server sends the owner back. Only the owner's
 * session finishes a flow it started; the code goes no further than this server, and the page it
 * redirects to gets no referrer.
 */
export async function handleToolOAuthCallback(request: Request, app: OAuthApp): Promise<Response> {
  const session = await app.auth.api.getSession({ headers: request.headers });
  const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
  if (!session) return new Response("Sign in to Dispand, then connect the tool again.", { status: 401, headers });
  const done = await finishToolAuthorization(app, session.user.id, new URL(request.url).searchParams);
  if (!done.toolId) return new Response("This sign-in isn't valid any more: connect the tool again from its page.", { status: 400, headers });
  return new Response(null, { status: 303, headers: { ...headers, location: `/settings/tools?tool=${encodeURIComponent(done.toolId)}` } });
}

/**
 * `GET /oauth/metadata`: Dispand's client metadata document, the client id it presents to an
 * authorization server that supports them. Public by design: it holds only the app's name and
 * callback address.
 */
export function clientDocument(appUrl: string): Response {
  return Response.json({ client_id: clientDocumentUrl(appUrl), ...clientMetadata(appUrl) }, { headers: { "cache-control": "public, max-age=3600" } });
}
