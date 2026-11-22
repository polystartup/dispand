import { beforeEach, expect, test, vi } from "vitest";

const createDb = vi.fn();
const recover = vi.fn(async () => {});
const seenAtRecovery: { db?: unknown; engine?: unknown }[] = [];
// What startup and shutdown did, in order.
const order: string[] = [];
const step =
  <T>(name: string, value?: T) =>
  () => {
    order.push(name);
    return value;
  };
vi.mock("@dispand/domain", () => ({
  createDb,
  closeDb: async () => order.push("closeDb"),
  createAuth: () => ({}),
  RunnerHub: class {
    updates = {};
  },
  DataEvents: class {},
  createSecretBox: () => ({}),
  syncPlatformSkills: async () => order.push("syncPlatformSkills"),
  ensureAssistants: async () => order.push("ensureAssistants"),
  resealToolHeaders: async () => step("resealToolHeaders", { resealed: 0 })(),
  createMcpConnector: () => ({}),
  guardedFetch: () => fetch,
  ownAddresses: () => ({}),
  // Recovery may already need a tool (a cloud session cut during a tool call): it reads the app then.
  platformToolCaller: (app: () => unknown) => ({ app }),
  createEngine: (_db: unknown, _hub: unknown, _secrets: unknown, _events: unknown, deps: { tools: { app: () => { db?: unknown; engine?: unknown } } }) => ({
    recover: async () => {
      order.push("recover");
      // A copy: the app as it is at this moment, not as it is filled later.
      seenAtRecovery.push({ ...deps.tools.app() });
      await recover();
    },
    stop: async () => order.push("engine.stop"),
  }),
  Scheduler: class {
    start = step("scheduler.start");
    stop = async () => order.push("scheduler.stop");
  },
  InstalledTools: class {},
  pollCaller: () => ({}),
  PushSender: class {
    start = step("push.start");
    stop = async () => order.push("push.stop");
  },
  pushVia: () => async () => {},
  sweepAttachments: async () => step("sweepAttachments", { removed: 0 })(),
  sweepAudit: async () => step("sweepAudit", { removed: 0 })(),
  logError: () => {},
  startTelemetry: step("startTelemetry", true),
  stopTelemetry: async () => order.push("stopTelemetry"),
}));

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "pglite://memory");
  delete (globalThis as { __dispandApp?: unknown }).__dispandApp;
  delete (globalThis as { __dispandBuilt?: unknown }).__dispandBuilt;
  createDb.mockReset();
  seenAtRecovery.length = 0;
  order.length = 0;
});

test("getApp retries after a failed start instead of caching the failure", async () => {
  const { getApp } = await import("./app.ts");
  createDb.mockRejectedValueOnce(new Error("database unavailable")).mockResolvedValueOnce({});
  await expect(getApp()).rejects.toThrow("database unavailable");
  await expect(getApp()).resolves.toMatchObject({ db: {} });
  expect(createDb).toHaveBeenCalledTimes(2);
  // The app Dispand's tools read was already filled when recovery ran.
  expect(seenAtRecovery).toHaveLength(1);
  expect(seenAtRecovery[0]!.db).toEqual({});
  expect(seenAtRecovery[0]!.engine).toBeDefined();
});

test("a retry after a failed start reuses the built app, so one engine drives its cloud sessions", async () => {
  const { getApp } = await import("./app.ts");
  createDb.mockResolvedValue({});
  recover.mockRejectedValueOnce(new Error("deadlock"));
  await expect(getApp()).rejects.toThrow("deadlock");
  await getApp();
  expect(createDb).toHaveBeenCalledTimes(1);
  // `createEngine` returns a new engine on every call: the same one means it was built once.
  expect(seenAtRecovery).toHaveLength(2);
  expect(seenAtRecovery[1]!.engine).toBe(seenAtRecovery[0]!.engine);
});

test("getApp opens and migrates, then starts the background work in order; closeApp stops that app", async () => {
  const { getApp, closeApp } = await import("./app.ts");
  createDb.mockImplementationOnce(async () => step("createDb", {})());
  await getApp();
  expect(order).toEqual([
    "startTelemetry",
    "createDb",
    "syncPlatformSkills",
    "ensureAssistants",
    "resealToolHeaders",
    "recover",
    "scheduler.start",
    "sweepAttachments",
    "sweepAudit",
    "push.start",
  ]);
  order.length = 0;
  await closeApp();
  expect(order).toEqual(["push.stop", "scheduler.stop", "engine.stop", "closeDb", "stopTelemetry"]);
});

test("setApp supplies the app getApp gives, without opening the server's own", async () => {
  const { getApp, setApp } = await import("./app.ts");
  const supplied = { db: {} } as Awaited<ReturnType<typeof getApp>>;
  setApp(supplied);
  expect(await getApp()).toBe(supplied);
  expect(createDb).not.toHaveBeenCalled();
  expect(order).toEqual([]);
});
