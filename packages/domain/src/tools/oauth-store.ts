import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { tools as toolsTable } from "../db/schema.ts";
import { secretAad, type SecretBox } from "../secrets.ts";
import { meter, recordError, tracer } from "../telemetry/index.ts";
import { ToolError } from "./errors.ts";
import type { OAuthState, OAuthStore } from "./oauth-provider.ts";

/** Where a tool's OAuth state is sealed. */
export const oauthAad = (toolId: string) => secretAad("tools", toolId, "oauth");

/** What the callback finds a flow by: the `state` itself is only in the seal. */
export const stateHash = (state: string) => createHash("sha256").update(state).digest("base64url");

export const emptyState = (): OAuthState => ({ issuers: {} });

export function openState(secrets: SecretBox, toolId: string, sealed: string | null): OAuthState {
  return sealed === null ? emptyState() : (JSON.parse(secrets.open(sealed, oauthAad(toolId))) as OAuthState);
}

/** The sealed state and the plain columns that follow from it. */
export function sealState(secrets: SecretBox, toolId: string, state: OAuthState) {
  return {
    oauthSealed: secrets.seal(JSON.stringify(state), oauthAad(toolId)),
    oauthStateHash: state.pending ? stateHash(state.pending.state) : null,
    oauthClientId: state.entered?.client_id ?? null,
  };
}

/** What a store is bound to: the tool, and the server it signs in to. */
export type OAuthTarget = { id: string; ownerId: string; url: string | null; transport: string | null };

/**
 * The tool's OAuth state in the database, sealed with the secret box; each change on the row
 * locked. Bound to the tool as `row` has it: once it is pointed at another server, or no longer
 * signs in with OAuth, the store reads nothing and writes nothing, so a flow or a refresh still
 * under way never gives the old server's tokens to the new one.
 */
export function oauthStore(db: Db, secrets: SecretBox, row: OAuthTarget): OAuthStore {
  const toolId = row.id;
  const mine = sameTarget(row);
  return {
    key: toolId,
    async read() {
      const [found] = await db.select({ sealed: toolsTable.oauthSealed }).from(toolsTable).where(mine);
      return openState(secrets, toolId, found?.sealed ?? null);
    },
    async change(edit) {
      await db.transaction(async (tx) => {
        const [found] = await tx.select({ sealed: toolsTable.oauthSealed }).from(toolsTable).where(mine).for("update");
        // Deleted, moved, or no longer an OAuth tool: what the flow hands over belongs to nobody.
        if (!found) return;
        const state = openState(secrets, toolId, found.sealed);
        edit(state);
        await tx.update(toolsTable).set(sealState(secrets, toolId, state)).where(mine);
      });
    },
    async reauthorize() {
      await db
        .update(toolsTable)
        .set({ oauthStatus: "reauthorize" })
        .where(mine);
    },
  };
}

/** The tool's row while it still signs in with OAuth to the server `row` names. */
export function sameTarget(row: OAuthTarget) {
  return and(
    eq(toolsTable.id, row.id),
    eq(toolsTable.ownerId, row.ownerId),
    eq(toolsTable.auth, "oauth"),
    row.url === null ? isNull(toolsTable.url) : eq(toolsTable.url, row.url),
    row.transport === null ? isNull(toolsTable.transport) : eq(toolsTable.transport, row.transport as "sse"),
    isNull(toolsTable.urlSealed),
  );
}

const traces = tracer("tools");
const counts = meter("tools");

export type OAuthStep = "authorize" | "callback" | "refresh";

/** Counts a step of a sign-in and how it ended: never a token, code, verifier, secret or the server's words. */
export function countOAuth(step: OAuthStep, result: string): void {
  counts.counter("dispand.tool.oauth").add(1, { "dispand.oauth.step": step, "dispand.result": result });
}

/** Runs a step of a tool's sign-in in a span with the tool's id and how it ended, and counts it. */
export function oauthStep<T>(step: OAuthStep, toolId: string, fn: () => Promise<T>): Promise<T> {
  return traces.startActiveSpan(`tool.oauth.${step}`, { attributes: { "dispand.tool.id": toolId, "dispand.oauth.step": step } }, async (span) => {
    let result = "ok";
    try {
      return await fn();
    } catch (error) {
      result = error instanceof ToolError || error instanceof ORPCError ? "refused" : "error";
      recordError(span, error instanceof Error ? error.name : "Error");
      throw error;
    } finally {
      span.setAttribute("dispand.result", result);
      span.end();
      countOAuth(step, result);
    }
  });
}
