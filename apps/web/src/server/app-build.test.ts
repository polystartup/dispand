import { Engine, PushSender, Scheduler } from "@dispand/domain";
import { ownerContext, recordingDb, recordScopes } from "@dispand/domain/test-support";
import { buildApp as buildThroughEntry } from "../server.ts";
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

test("buildApp with authDb sends Better Auth's queries there", async () => {
  const owner = await ownerContext();
  const domain = await recordScopes(owner.db);
  const identity = await recordingDb(owner.db);
  const config = loadServerConfig({ DATABASE_URL: "pglite://memory" }, "development");
  // Through the entry other servers build with, so its option reaches the app.
  const app = await buildThroughEntry(domain.db, { ...config, baseURL: "https://dispand.test" }, { authDb: identity.db });
  onTestFinished(async () => {
    await app.hub.close();
    await app.engine.stop();
  });
  expect(app.authDb).toBe(identity.db);
  const signIn = await app.auth.api.signInEmail({ body: { email: "ada@example.com", password: "correct horse battery" }, returnHeaders: true });
  const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const session = await app.auth.api.getSession({ headers: new Headers({ cookie }) });
  expect(session?.user.email).toBe("ada@example.com");
  expect(identity.statements.some((s) => s.includes('"session"'))).toBe(true);
  // The guarded domain database saw nothing (a statement there would have thrown, unscoped).
  expect(domain.statements).toEqual([]);
});
