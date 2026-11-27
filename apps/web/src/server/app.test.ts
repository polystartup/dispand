import { beforeEach, expect, onTestFinished, test, vi } from "vitest";

const createDb = vi.fn();
const recover = vi.fn(async () => {});
const logError = vi.fn();
// The database lock (`lockDatabase`): held until released; `refuse` sets its `refusal` and settles
// its `refused`, as when it went to another process while its connection was gone.
class DatabaseLocked extends Error {}
let refuse = () => {};
const lockDatabase = vi.fn(async () => {
  order.push("lockDatabase");
  let settle: (refusal: DatabaseLocked) => void = () => {};
  const lock = {
    refused: new Promise<DatabaseLocked>((resolve) => (settle = resolve)),
    refusal: undefined as DatabaseLocked | undefined,
    release: async () => void order.push("lock.release"),
  };
  refuse = () => settle((lock.refusal = new DatabaseLocked()));
  return lock;
});
const seenAtRecovery: { db?: unknown; engine?: unknown }[] = [];
// What startup and shutdown did, in order.
const order: string[] = [];
// The scope each step ran in (`inScope` below keeps one at a time: startup awaits its steps in turn).
const SYSTEM = Symbol.for("dispand.scope.system");
let ambient: unknown;
const scopes = new Map<string, unknown>();
const step =
  <T>(name: string, value?: T) =>
  () => {
    order.push(name);
    scopes.set(name, ambient);
    return value;
  };
vi.mock("@dispand/domain", () => ({
  SYSTEM,
  inScope: async (scope: unknown, work: () => unknown) => {
    const outer = ambient;
    ambient = scope;
    try {
      return await work();
    } finally {
      ambient = outer;
    }
  },
  createDb,
  DatabaseLocked,
  lockDatabase,
  closeDb: async () => order.push("closeDb"),
  createAuth: () => ({}),
  RunnerHub: class {
    updates = {};
  },
  DataEvents: class {},
  createSecretBox: () => ({}),
  syncPlatformSkills: async () => step("syncPlatformSkills")(),
  ensureAssistants: async () => step("ensureAssistants")(),
  resealToolHeaders: async () => step("resealToolHeaders", { resealed: 0 })(),
  createMcpConnector: () => ({}),
  guardedFetch: () => fetch,
  ownAddresses: () => ({}),
  // Recovery may already need a tool (a cloud session cut during a tool call): it reads the app then.
  platformToolCaller: (app: () => unknown) => ({ app }),
  createEngine: (_db: unknown, _hub: unknown, _secrets: unknown, _events: unknown, deps: { tools: { app: () => { db?: unknown; engine?: unknown } } }) => ({
    settleIdleChats: step("settleIdleChats"),
    recover: async () => {
      step("recover")();
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
  localFiles: () => ({}),
  pollCaller: () => ({}),
  PushSender: class {
    start = step("push.start");
    stop = async () => order.push("push.stop");
  },
  pushVia: () => async () => {},
  sweepAttachments: async () => step("sweepAttachments", { removed: 0 })(),
  sweepAudit: async () => step("sweepAudit", { removed: 0 })(),
  purgeArchivedPeople: async () => step("purgeArchivedPeople", { purged: 0 })(),
  logError,
  startTelemetry: step("startTelemetry", true),
  stopTelemetry: async () => order.push("stopTelemetry"),
}));

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "pglite://memory");
  delete (globalThis as { __dispandApp?: unknown }).__dispandApp;
  delete (globalThis as { __dispandBuilt?: unknown }).__dispandBuilt;
  delete (globalThis as { __dispandLock?: unknown }).__dispandLock;
  createDb.mockReset();
  lockDatabase.mockReset();
  logError.mockReset();
  seenAtRecovery.length = 0;
  order.length = 0;
  scopes.clear();
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
    "lockDatabase",
    "createDb",
    "syncPlatformSkills",
    "ensureAssistants",
    "resealToolHeaders",
    "settleIdleChats",
    "recover",
    "scheduler.start",
    "sweepAttachments",
    "sweepAudit",
    "push.start",
  ]);
  order.length = 0;
  await closeApp();
  expect(order).toEqual(["push.stop", "scheduler.stop", "engine.stop", "closeDb", "lock.release", "stopTelemetry"]);
});

test("a start takes the lock again if it couldn't be taken, and keeps the one a failed start took", async () => {
  const { getApp } = await import("./app.ts");
  lockDatabase.mockRejectedValueOnce(new Error("connection refused"));
  createDb.mockRejectedValueOnce(new Error("database unavailable")).mockResolvedValueOnce({});
  await expect(getApp()).rejects.toThrow("connection refused");
  await expect(getApp()).rejects.toThrow("database unavailable");
  await getApp();
  expect(lockDatabase).toHaveBeenCalledTimes(2);
  expect(createDb).toHaveBeenCalledTimes(2);
});

test("serve's own app stops the process when another holds the database, before migrating anything", async () => {
  const { startOwnApp } = await import("./app.ts");
  lockDatabase.mockRejectedValueOnce(new DatabaseLocked());
  const stop = vi.fn();
  await startOwnApp(stop);
  expect(stop).toHaveBeenCalledOnce();
  expect(createDb).not.toHaveBeenCalled();
  expect(logError).toHaveBeenCalledWith("another Dispand process runs on this database: this one stops", expect.any(DatabaseLocked));
});

test("serve's own app is tried again every 5 s until it starts, then stops the process once its lock is another's", async () => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const { startOwnApp } = await import("./app.ts");
  createDb.mockRejectedValueOnce(new Error("database unavailable")).mockResolvedValueOnce({});
  const stop = vi.fn();
  const own = startOwnApp(stop);
  await vi.advanceTimersByTimeAsync(0);
  expect(createDb).toHaveBeenCalledOnce();
  expect(logError).toHaveBeenCalledWith("app.start failed", expect.any(Error));
  await vi.advanceTimersByTimeAsync(4_999);
  expect(createDb).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(order).toContain("scheduler.start");
  // One lock for both starts: the failed one kept it.
  expect(lockDatabase).toHaveBeenCalledOnce();
  expect(stop).not.toHaveBeenCalled();
  refuse();
  await own;
  await vi.advanceTimersByTimeAsync(0);
  expect(stop).toHaveBeenCalledOnce();
  expect(logError).toHaveBeenLastCalledWith("another Dispand process runs on this database: this one stops", expect.any(DatabaseLocked));
});

test("serve's own app stops the process at once when its lock goes to another while it waits to start again, and nothing starts on it", async () => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const { getApp, startOwnApp } = await import("./app.ts");
  createDb.mockRejectedValueOnce(new Error("database unavailable")).mockResolvedValue({});
  const stop = vi.fn();
  void startOwnApp(stop);
  await vi.advanceTimersByTimeAsync(0);
  expect(createDb).toHaveBeenCalledOnce();
  refuse();
  await vi.advanceTimersByTimeAsync(0);
  expect(stop).toHaveBeenCalledOnce();
  expect(logError).toHaveBeenLastCalledWith("another Dispand process runs on this database: this one stops", expect.any(DatabaseLocked));
  // Neither the retry nor a request starts anything on the refused lock.
  await vi.advanceTimersByTimeAsync(5_000);
  await expect(getApp()).rejects.toBeInstanceOf(DatabaseLocked);
  expect(createDb).toHaveBeenCalledOnce();
  expect(order).not.toContain("recover");
  expect(stop).toHaveBeenCalledOnce();
});

test("serve's own app stops the process at once when its lock goes to another while it starts", async () => {
  const { startOwnApp } = await import("./app.ts");
  createDb.mockResolvedValueOnce({});
  let resume = () => {};
  recover.mockImplementationOnce(() => {
    refuse();
    return new Promise<void>((resolve) => (resume = resolve));
  });
  const stop = vi.fn();
  const own = startOwnApp(stop);
  // Before the start under way is done.
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  expect(order).not.toContain("scheduler.start");
  resume();
  await own;
});

test("a start whose lock goes to another while it migrates starts nothing", async () => {
  const { getApp } = await import("./app.ts");
  createDb.mockImplementationOnce(async () => {
    refuse();
    return step("createDb", {})();
  });
  await expect(getApp()).rejects.toBeInstanceOf(DatabaseLocked);
  expect(order).toEqual(["startTelemetry", "lockDatabase", "createDb"]);
});

test("startApp runs its startup work under SYSTEM", async () => {
  const { getApp } = await import("./app.ts");
  createDb.mockImplementationOnce(async () => ({}));
  await getApp();
  for (const name of ["syncPlatformSkills", "ensureAssistants", "resealToolHeaders", "settleIdleChats", "recover"]) expect(scopes.get(name), name).toBe(SYSTEM);
});

test("setApp supplies the app getApp gives, without opening the server's own", async () => {
  const { getApp, setApp } = await import("./app.ts");
  const supplied = { db: {} } as Awaited<ReturnType<typeof getApp>>;
  setApp(supplied);
  expect(await getApp()).toBe(supplied);
  expect(createDb).not.toHaveBeenCalled();
  expect(order).toEqual([]);
});

test("the purge waits for the next 03:00 of the server's clock", async () => {
  const { untilPurge } = await import("./app.ts");
  const at = (h: number, m = 0) => {
    const d = new Date(2026, 10, 24, h, m);
    return d;
  };
  expect(untilPurge(at(1))).toBe(2 * 3600_000);
  expect(untilPurge(at(3))).toBe(24 * 3600_000);
  expect(untilPurge(at(23, 30))).toBe(3.5 * 3600_000);
});
