import { api } from "./api.ts";
import { detectLanguage } from "./i18n.ts";

// Web Push on this browser (`public/sw.js`, `packages/domain/src/push/`): what the Inbox's opt-in
// turns on and signing out turns off.

/** Whether this browser can get pushes with no Dispand tab open (a secure context with a service worker). */
export function pushSupported(): boolean {
  try {
    return window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window;
  } catch {
    return false;
  }
}

/** This browser's push subscription, if it has one. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** The server's key, as `pushManager.subscribe` takes it. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const text = atob(base64url.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

/**
 * Subscribes this browser (notification permission already granted) and tells the server, with
 * the language the browser shows: again for a browser already subscribed, so its language stays current.
 */
export async function subscribeDevice(): Promise<void> {
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const known = await registration.pushManager.getSubscription();
  const subscription = known ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes((await api.push.list()).publicKey) }));
  const { endpoint, keys } = subscription.toJSON();
  try {
    await api.push.subscribe({ endpoint: endpoint!, keys: { p256dh: keys!.p256dh!, auth: keys!.auth! }, language: detectLanguage(navigator.languages) });
  } catch (err) {
    // A new one the server never got: no push comes, so the open tab must keep alerting (it stays quiet
    // while subscribed). One the server already has stays: a refresh that failed changes nothing.
    if (!known) await subscription.unsubscribe().catch(() => {});
    throw err;
  }
}

/** Signing out: the server forgets this browser, then the browser drops its subscription. Never blocks signing out. */
export async function unsubscribeDevice(): Promise<void> {
  try {
    const subscription = await currentSubscription();
    if (!subscription) return;
    await api.push.unsubscribe({ endpoint: subscription.endpoint }).catch(() => {});
    await subscription.unsubscribe();
  } catch {
    // Nothing to undo on this browser.
  }
}
