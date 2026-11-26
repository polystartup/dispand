import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { workspaces } from "../db/schema.ts";
import { inScope, refusalOf, refuses, SYSTEM, type OrganizationRefusal } from "../db/scope.ts";
import { english, isMessageKey, type MessageKey } from "../messages/index.ts";
import { meter, spanEvent } from "../telemetry/index.ts";

// The organization gate: an install may refuse an organization (`Tenancy.refusal`). What reaches
// into one is checked at use, once its caller is admitted there, and answers FORBIDDEN with the
// install's message and link.

/** Where a refusal was met: its metric's only attribute, never the organization, the link or words. */
export type RefusalPath = "request" | "stream" | "job_call" | "work";

const refusals = meter("workspace").counter("dispand.organization.refusals", { description: "Uses of an organization its install refuses, by where they were met" });

/**
 * An error's options for an organization the install refuses: the message key it registered, else
 * `organization.refused`, with its link and the organization as data.
 */
export function refusedMessage(refusal: OrganizationRefusal, organizationId: string): { message: string; data: { key: MessageKey; link: string; organizationId: string } } {
  const key: MessageKey = isMessageKey(refusal.key) ? refusal.key : "organization.refused";
  return { message: english(key), data: { key, link: refusal.link, organizationId } };
}

/**
 * The install's refusal of the organization as the error to answer with, counted; undefined while
 * it may be used. Ask only once the caller is admitted there: an outsider's NOT_FOUND tells nothing.
 */
export function organizationRefusal(db: Db, organizationId: string, path: RefusalPath): ORPCError<"FORBIDDEN", unknown> | undefined {
  const refusal = refusalOf(db, organizationId);
  if (!refusal) return undefined;
  refusals.add(1, { "dispand.refusal.path": path });
  spanEvent("organization.refused", { "dispand.organization.id": organizationId, "dispand.refusal.path": path });
  return new ORPCError("FORBIDDEN", refusedMessage(refusal, organizationId));
}

/** Throws the refusal of a request into the organization, if the install refuses it. */
export function refuseOrganization(db: Db, organizationId: string): void {
  const refused = organizationRefusal(db, organizationId, "request");
  if (refused) throw refused;
}

/** `organizationRefusal` of a workspace's organization, read under SYSTEM only when the install may refuse one. */
export async function workspaceRefusal(db: Db, workspaceId: string, path: RefusalPath): Promise<ORPCError<"FORBIDDEN", unknown> | undefined> {
  if (!refuses(db)) return undefined;
  const [placed] = await inScope(SYSTEM, () => db.select({ organizationId: workspaces.organizationId }).from(workspaces).where(eq(workspaces.id, workspaceId)));
  return placed && organizationRefusal(db, placed.organizationId, path);
}

/** For a plain HTTP route (a file, an OAuth callback): a refusal as 403 with its sentence; anything else is thrown on. */
export function answerRefusal(err: unknown): Response {
  if (err instanceof ORPCError && err.code === "FORBIDDEN") return new Response(err.message, { status: 403, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  throw err;
}
