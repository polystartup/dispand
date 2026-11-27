import { eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { workspaces } from "../db/schema.ts";
import { ownerContext, stopsBeforeEmptied, testDb } from "./test-support.ts";

// A test may ask for a second context: emptying the database under the first one's engine would
// deadlock with its statements on PostgreSQL (#586), so what it runs stops first, once.
test("a later context of the test stops what an earlier one runs before it empties the database", async () => {
  const first = await ownerContext();
  const engine = vi.spyOn(first.engine, "stop");
  const hub = vi.spyOn(first.hub, "close");
  let release!: () => void;
  const own = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
  stopsBeforeEmptied(own);
  const second = ownerContext();
  await vi.waitFor(() => expect(own).toHaveBeenCalledTimes(1));
  expect(hub).toHaveBeenCalledTimes(1);
  expect(engine).toHaveBeenCalledTimes(1);
  // Not emptied while something still stops: the first context's workspace is there until then.
  expect(await first.db.select().from(workspaces).where(eq(workspaces.id, first.workspaceId))).toHaveLength(1);
  release();
  await second;
  expect(await first.db.select().from(workspaces).where(eq(workspaces.id, first.workspaceId))).toEqual([]);
  // Stopped already: the next emptying, and the test's end, don't stop it again.
  await testDb();
  expect([hub, engine, own].map((spy) => spy.mock.calls.length)).toEqual([1, 1, 1]);
});
