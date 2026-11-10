import { expect, test, vi } from "vitest";

const createDb = vi.fn();
const seenAtRecovery: { db?: unknown; engine?: unknown }[] = [];
vi.mock("@dispand/domain", () => ({
  createDb,
  createAuth: () => ({}),
  getHub: () => ({}),
  getDataEvents: () => ({}),
  createSecretBox: () => ({}),
  createMcpConnector: () => ({}),
  guardedFetch: () => fetch,
  ownAddresses: () => ({}),
  // Recovery may already need a tool (a cloud session cut during a tool call): it reads the app then.
  platformToolCaller: (app: () => unknown) => ({ app }),
  getEngine: (_db: unknown, _hub: unknown, _secrets: unknown, _events: unknown, deps: { tools: { app: () => { db?: unknown; engine?: unknown } } }) => ({
    recover: async () => {
      seenAtRecovery.push(deps.tools.app());
    },
  }),
  getScheduler: () => ({ start: () => {}, stop: async () => {} }),
  sweepAttachments: async () => ({ removed: 0 }),
  logError: () => {},
}));

test("getApp retries after a failed start instead of caching the failure", async () => {
  vi.stubEnv("DATABASE_URL", "pglite://memory");
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
