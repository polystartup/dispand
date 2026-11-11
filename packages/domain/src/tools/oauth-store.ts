import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
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

/** The tool's OAuth state in the database, sealed with the secret box; each change on the row locked. */
export function oauthStore(db: Db, secrets: SecretBox, toolId: string, ownerId: string): OAuthStore {
  const mine = and(eq(toolsTable.id, toolId), eq(toolsTable.ownerId, ownerId));
  return {
    async read() {
      const [row] = await db.select({ sealed: toolsTable.oauthSealed }).from(toolsTable).where(mine);
      return openState(secrets, toolId, row?.sealed ?? null);
    },
    async change(edit) {
      await db.transaction(async (tx) => {
        const [row] = await tx.select({ sealed: toolsTable.oauthSealed, auth: toolsTable.auth }).from(toolsTable).where(mine).for("update");
        // Deleted, or no longer an OAuth tool: what the flow hands over belongs to nobody.
        if (!row || row.auth !== "oauth") return;
        const state = openState(secrets, toolId, row.sealed);
        edit(state);
        await tx.update(toolsTable).set(sealState(secrets, toolId, state)).where(mine);
      });
    },
    async reauthorize() {
      await db
        .update(toolsTable)
        .set({ oauthStatus: "reauthorize" })
        .where(and(mine, eq(toolsTable.auth, "oauth")));
    },
  };
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
