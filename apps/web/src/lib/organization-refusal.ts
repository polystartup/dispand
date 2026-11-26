import { ORPCError } from "@orpc/client";
import { useSyncExternalStore } from "react";

/** An organization the install refuses, as the server said: its sentence (already in the page's language) and where to go. */
export type OrganizationRefusal = { organizationId: string; message: string; link: string };

/** The server's refusal of a whole organization: FORBIDDEN with the organization and a link, unlike every other FORBIDDEN (a manager-only action, a limit). */
export function organizationRefusalOf(error: unknown): OrganizationRefusal | undefined {
  if (!(error instanceof ORPCError) || error.code !== "FORBIDDEN") return undefined;
  const { link, organizationId } = (error.data ?? {}) as { link?: unknown; organizationId?: unknown };
  return typeof link === "string" && typeof organizationId === "string" ? { organizationId, message: error.message, link } : undefined;
}

// Written by the API link when a call fails, never while rendering; read by the `_app` layout.
let refused = new Map<string, OrganizationRefusal>();
const listeners = new Set<() => void>();
const changed = (next: Map<string, OrganizationRefusal>) => {
  refused = next;
  for (const listener of listeners) listener();
};

/** Records the refusal an error carries, for the organization it names (a call sent before a switch can fail after it). */
export function noteRefusal(error: unknown): void {
  const refusal = organizationRefusalOf(error);
  if (refusal) changed(new Map(refused).set(refusal.organizationId, refusal));
}

/** Forgets every refusal: the next calls into an organization ask again. */
export function forgetRefusals(): void {
  if (refused.size) changed(new Map());
}

/** The refusal of `organizationId` the page has met, if any. */
export const refusalFor = (organizationId: string): OrganizationRefusal | undefined => refused.get(organizationId);

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The refusal of `organizationId` the page has met; none on the server, so hydration matches. */
export function useOrganizationRefusal(organizationId: string | undefined): OrganizationRefusal | null {
  return useSyncExternalStore(subscribe, () => (organizationId && refusalFor(organizationId)) || null, () => null);
}

/** Where the refusal's link may lead: an https address, or a path on this origin; anything else (a script, plain http, another origin written as a path) is no link. */
export function safeLink(link: string, origin = window.location.origin): string | undefined {
  const absolute = /^https:\/\//i.test(link);
  try {
    const url = new URL(link, origin);
    return absolute || url.origin === origin ? url.href : undefined;
  } catch {
    return undefined;
  }
}
