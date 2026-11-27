import { expect, onTestFinished, test, vi } from "vitest";
import type { App } from "./app.ts";
import { loadServerConfig } from "./config.ts";

const startOwnApp = vi.fn<(stop: () => void) => Promise<void>>(async () => {});
const setApp = vi.fn();
vi.mock("./app.ts", () => ({ startOwnApp, setApp, closeApp: async () => {}, closeHub: async () => {} }));

/** `serve` on a free port of the loopback, stopped with its signal handlers when the test ends. */
async function served(app: App | undefined) {
  const { serve } = await import("../server.ts");
  const listeners = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  const server = await serve(app, { ...loadServerConfig({ DATABASE_URL: "pglite://memory" }, "development"), host: "127.0.0.1", port: 0 });
  onTestFinished(async () => {
    await server.close(true);
    // serve's own signal handlers, not the test runner's.
    for (const signal of ["SIGINT", "SIGTERM"] as const) for (const l of process.listeners(signal)) if (!listeners[signal].includes(l)) process.off(signal, l);
  });
  // The start `serve` sets off is an import away.
  await vi.dynamicImportSettled();
}

test("serve without an app starts its own once listening, not at the first request, and exits 1 when that one may not run", async () => {
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  onTestFinished(() => exit.mockRestore());
  await served(undefined);
  expect(startOwnApp).toHaveBeenCalledOnce();
  expect(exit).not.toHaveBeenCalled();
  startOwnApp.mock.calls[0]![0]();
  expect(exit).toHaveBeenCalledWith(1);
});

test("serve with the entry's own app starts nothing of its own", async () => {
  startOwnApp.mockClear();
  const app = {} as App;
  await served(app);
  expect(setApp).toHaveBeenCalledWith(app);
  expect(startOwnApp).not.toHaveBeenCalled();
});
