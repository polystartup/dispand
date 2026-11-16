/* global self */
// Dispand's service worker: shows the Web Push the server sends for new Inbox items
// (`packages/domain/src/push/sender.ts`). The payload is `{ text, count, itemId }`: a sentence
// naming the agent and the item's kind, already in the person's language, and the newest item's id.

self.addEventListener("push", (event) => {
  const { text, itemId } = event.data ? event.data.json() : {};
  if (!text) return;
  event.waitUntil(
    (async () => {
      // A focused Dispand window shows its own alert: no second one.
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (windows.some((client) => client.focused)) return;
      await self.registration.showNotification("Dispand", { body: text, tag: "dispand-inbox", data: { itemId } });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const itemId = event.notification.data && event.notification.data.itemId;
  event.waitUntil(self.clients.openWindow(itemId ? `/inbox?item=${encodeURIComponent(itemId)}` : "/inbox"));
});
