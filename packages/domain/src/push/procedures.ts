import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { pushSubscriptions } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { authed, base } from "../rpc/context.ts";
import { subscriptionKeysAad, vapidKeys } from "./keys.ts";

const owner = base.use(authed);

/** "Chrome on Android": what the owner reads to tell their devices apart, from the user agent. */
export function deviceLabel(userAgent: string): string {
  const browser = /Edg\//.test(userAgent) ? "Edge" : /Firefox\//.test(userAgent) ? "Firefox" : /Chrome\//.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) ? "Safari" : "Browser";
  const system = /Android/.test(userAgent) ? "Android" : /iPhone|iPad/.test(userAgent) ? "iOS" : /Mac OS X/.test(userAgent) ? "macOS" : /Windows/.test(userAgent) ? "Windows" : /Linux/.test(userAgent) ? "Linux" : null;
  return system ? `${browser} on ${system}` : browser;
}

// What `PushSubscription.toJSON()` gives, with the language that browser shows. The server posts to
// the endpoint: only an https URL is taken.
const SubscribeInput = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(2048),
  keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(256) }),
  language: z.enum(["en", "fr"]),
});

/** Allows this browser: items asked from now on reach it. Again for a known endpoint, its keys, label and language are refreshed, not its start. */
const subscribe = owner.input(SubscribeInput).handler(async ({ input, context }) => {
  const keys = context.secrets.seal(JSON.stringify(input.keys), subscriptionKeysAad(input.endpoint));
  const label = deviceLabel(context.headers.get("user-agent") ?? "");
  await context.db
    .insert(pushSubscriptions)
    .values({ id: newId("push"), ownerId: context.ownerId, endpoint: input.endpoint, keys, label, language: input.language })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { keys, label, language: input.language }, setWhere: eq(pushSubscriptions.ownerId, context.ownerId) });
});

/** Stops pushes to this browser (signing out, or turned off). */
const unsubscribe = owner.input(z.object({ endpoint: z.string().max(2048) })).handler(async ({ input, context }) => {
  await context.db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.ownerId, context.ownerId), eq(pushSubscriptions.endpoint, input.endpoint)));
});

/** The key a browser subscribes with, and the owner's allowed devices (never their endpoints or keys). */
const list = owner.handler(async ({ context }) => {
  const { publicKey } = await vapidKeys(context.db, context.secrets);
  const devices = await context.db
    .select({ id: pushSubscriptions.id, label: pushSubscriptions.label, language: pushSubscriptions.language, createdAt: pushSubscriptions.createdAt })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.ownerId, context.ownerId))
    .orderBy(desc(pushSubscriptions.createdAt));
  return { publicKey, devices };
});

export const push = { subscribe, unsubscribe, list };
