import { closeDb, createDb } from "@dispand/domain";
import { expect, test } from "vitest";
import { handleHealth } from "./health.ts";

test("ready once the app started and the database answers", async () => {
  const db = await createDb("pglite://memory");
  const ok = await handleHealth(async () => ({ db }));
  expect(ok.status).toBe(200);
  expect(await ok.text()).toBe("ok");
  await closeDb(db);
  // The database went away: not ready.
  expect((await handleHealth(async () => ({ db }))).status).toBe(503);
});

test("not ready while the app can't start, and nothing of the error is shown", async () => {
  const res = await handleHealth(async () => {
    throw new Error("password authentication failed for user dispand at db:5432");
  });
  expect(res.status).toBe(503);
  expect(await res.text()).toBe("unavailable");
});
