// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ push: { unsubscribe: vi.fn(), subscribe: vi.fn(), list: vi.fn() } }));
vi.mock("./api.ts", () => ({ api: fake }));
const { unsubscribeDevice } = await import("./push.ts");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

test("signing out makes the server forget this browser, then drops its subscription", async () => {
  const order: string[] = [];
  const subscription = { endpoint: "https://push.example.com/phone", unsubscribe: vi.fn(async () => order.push("browser")) };
  fake.push.unsubscribe.mockImplementation(async () => order.push("server"));
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("PushManager", class {});
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => ({ pushManager: { getSubscription: async () => subscription } }) } });
  await unsubscribeDevice();
  expect(fake.push.unsubscribe).toHaveBeenCalledWith({ endpoint: "https://push.example.com/phone" });
  expect(order).toEqual(["server", "browser"]);
});

/** Runs `public/sw.js` against a fake worker scope; returns its handlers and what it showed or opened. */
function worker() {
  const handlers: Record<string, (event: unknown) => void> = {};
  const shown: unknown[] = [];
  const opened: string[] = [];
  const self = {
    addEventListener: (type: string, handler: (event: unknown) => void) => (handlers[type] = handler),
    clients: { openWindow: async (url: string) => opened.push(url) },
    registration: { showNotification: async (title: string, options: unknown) => shown.push([title, options]) },
  };
  runInNewContext(readFileSync(join(import.meta.dirname, "../../public/sw.js"), "utf8"), { self });
  const dispatch = async (type: string, event: object) => {
    let done: Promise<unknown> = Promise.resolve();
    handlers[type]!({ ...event, waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
  };
  return { dispatch, shown, opened };
}

const payload = { data: { json: () => ({ text: "Drafting needs your decision.", count: 1, itemId: "q_1" }) } };

test("the service worker shows every push, and a click opens its item", async () => {
  const hidden = worker();
  await hidden.dispatch("push", payload);
  expect(hidden.shown).toEqual([["Dispand", { body: "Drafting needs your decision.", tag: "dispand-inbox", data: { itemId: "q_1" } }]]);
  await hidden.dispatch("notificationclick", { notification: { close: () => {}, data: { itemId: "q_1" } } });
  expect(hidden.opened).toEqual(["/inbox?item=q_1"]);
});

test("a new subscription the server refused is dropped, so the open tab keeps alerting; a known one stays", async () => {
  const subscription = { toJSON: () => ({ endpoint: "https://push.example.com/phone", keys: { p256dh: "p", auth: "a" } }), unsubscribe: vi.fn(async () => true) };
  let known: typeof subscription | null = null;
  fake.push.subscribe.mockRejectedValue(new Error("offline"));
  fake.push.list.mockResolvedValue({ publicKey: "AAAA", devices: [] });
  const pushManager = { getSubscription: async () => known, subscribe: async () => subscription };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register: async () => ({ pushManager }), ready: Promise.resolve() } });
  const { subscribeDevice } = await import("./push.ts");
  await expect(subscribeDevice()).rejects.toThrow("offline");
  expect(subscription.unsubscribe).toHaveBeenCalledOnce();
  known = subscription;
  await expect(subscribeDevice()).rejects.toThrow("offline");
  expect(subscription.unsubscribe).toHaveBeenCalledOnce();
});
