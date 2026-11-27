import { expect, test, vi } from "vitest";

// `test-wait.ts`, a setup file, raises vi.waitFor's default timeout.
test("vi.waitFor waits past Vitest's 1 s, unless the call gives its own timeout", async () => {
  const start = Date.now();
  const twoSecondsPassed = () => {
    expect(Date.now() - start).toBeGreaterThan(2_000);
  };
  await expect(vi.waitFor(twoSecondsPassed, { timeout: 100 })).rejects.toThrow();
  await expect(vi.waitFor(twoSecondsPassed, 100)).rejects.toThrow();
  await vi.waitFor(twoSecondsPassed);
  // A helper passing its optional timeout on as undefined gets the default too.
  const later = Date.now();
  await vi.waitFor(() => expect(Date.now() - later).toBeGreaterThan(2_000), { timeout: undefined });
});
