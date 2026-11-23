import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { workspaceMembers } from "../db/schema.ts";
import { ownerContext, personContext } from "../runners/test-support.ts";
import { router } from "./router.ts";

test("levels › members share the workspace's tables, fields and rows, whoever made them", async () => {
  const owner = await ownerContext();
  const table = await call(router.tables.create, { name: "Clients" }, { context: owner });
  const pat = await personContext(owner, "pat", "member");
  expect((await call(router.tables.list, undefined, { context: pat })).map((t) => t.id)).toEqual([table.id]);
  const field = await call(router.fields.create, { tableId: table.id, name: "City", type: "text" }, { context: pat });
  const row = await call(router.rows.create, { tableId: table.id, values: { [field.id]: "Lyon" } }, { context: pat });
  expect((await call(router.rows.list, { tableId: table.id }, { context: owner })).rows.map((r) => r.id)).toEqual([row.id]);
  await call(router.rows.update, { id: row.id, values: { [field.id]: "Paris" } }, { context: owner });
  await call(router.rows.delete, { ids: [row.id] }, { context: pat });
  await call(router.tables.rename, { id: table.id, name: "Customers" }, { context: pat });
  await call(router.tables.delete, { id: table.id }, { context: pat });
  expect(await call(router.tables.list, undefined, { context: owner })).toEqual([]);
});

test("streams › a member removed while watching rows gets FORBIDDEN on the next event", async () => {
  const owner = await ownerContext();
  const table = await call(router.tables.create, { name: "Clients" }, { context: owner });
  const pat = await personContext(owner, "pat", "member");
  const abort = new AbortController();
  const stream = await call(router.rows.stream, { tableIds: [table.id] }, { context: pat, signal: abort.signal });
  try {
    const first = stream.next();
    await call(router.rows.create, { tableId: table.id }, { context: owner });
    expect((await first).value).toMatchObject({ tableId: table.id });
    await owner.db.delete(workspaceMembers).where(eq(workspaceMembers.userId, "pat"));
    const next = stream.next();
    await call(router.rows.create, { tableId: table.id }, { context: owner });
    await expect(next).rejects.toMatchObject({ code: "FORBIDDEN" });
  } finally {
    abort.abort();
    await stream.return?.(undefined);
  }
});
