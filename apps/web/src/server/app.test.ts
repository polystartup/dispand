import { expect, test, vi } from "vitest";

const createDb = vi.fn();
vi.mock("@dispand/domain", () => ({
  createDb,
  createAuth: () => ({}),
  getHub: () => ({}),
  getDataEvents: () => ({}),
  createSecretBox: () => ({}),
  createMcpConnector: () => ({}),
  guardedFetch: () => fetch,
  ownAddresses: () => ({}),
  getEngine: () => ({ recover: async () => {} }),
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
});
