/* global self */
// Dispand's service worker: shows the Web Push the server sends for new Inbox items
// (`packages/domain/src/push/sender.ts`). The payload is `{ text, count, itemId }`: a sentence
// naming the agent and the item's kind, already in the person's language, and the newest item's id.

self.addEventListener("push", (event) => {
  const { text, itemId } = event.data ? event.data.json() : {};
  if (!text) return;
  // Every push shows, a focused window or not: Safari revokes a subscription whose push showed
  // nothing. An open tab stays quiet while its browser gets pushes (`NotificationsBell.tsx`).
  event.waitUntil(self.registration.showNotification("Dispand", { body: text, tag: "dispand-inbox", data: { itemId } }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const itemId = event.notification.data && event.notification.data.itemId;
  event.waitUntil(self.clients.openWindow(itemId ? `/inbox?item=${encodeURIComponent(itemId)}` : "/inbox"));
});
