import { afterEach, expect, test, vi } from "vitest";

vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => ({}), setResponseHeader: () => {} }));
vi.mock("./app.ts", () => ({
  getApp: async () => ({
    db: {
      select: () => {
        throw new Error('Failed query: select count(*) from "user"');
      },
    },
    auth: {},
    setupCode: "x".repeat(20),
  }),
}));

afterEach(() => vi.restoreAllMocks());

test("the auth state loader with a failing database gives a generic error", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { authState } = await import("./auth-state.ts");
  const { safe } = await import("./safe.ts");
  const error = await safe(authState)().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect(String((error as Error).message)).toBe("Something went wrong");
});
