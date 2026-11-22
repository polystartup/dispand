import { Engine, PushSender, Scheduler } from "@dispand/domain";
import { recordingDb } from "@dispand/domain/test-support";
import { expect, onTestFinished, test, vi } from "vitest";
import { buildApp } from "./app.ts";
import { loadServerConfig } from "./config.ts";

test("buildApp builds on a database without migrating, recovering or starting anything", async () => {
  const { db, statements } = await recordingDb();
  const config = loadServerConfig({ DATABASE_URL: "pglite://memory" }, "development");
  const timers = vi.spyOn(globalThis, "setInterval");
  const recover = vi.spyOn(Engine.prototype, "recover");
  const scheduler = vi.spyOn(Scheduler.prototype, "start");
  const push = vi.spyOn(PushSender.prototype, "start");
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  const app = buildApp(db, config);
  const other = buildApp(db, config);
  onTestFinished(async () => {
    for (const built of [app, other]) {
      await built.hub.close();
      await built.engine.stop();
    }
  });
  expect(app.db).toBe(db);
  // No query at all: no migration, sync, recovery or sweep.
  expect(statements).toEqual([]);
  expect(timers).not.toHaveBeenCalled();
  expect(recover).not.toHaveBeenCalled();
  expect(scheduler).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
  // Each build owns its instances: nothing is shared through the process.
  for (const key of ["hub", "engine", "scheduler", "dataEvents", "push"] as const) expect(other[key]).not.toBe(app[key]);
});
