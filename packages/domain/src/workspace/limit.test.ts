import { call } from "@orpc/server";
import { sql } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { closeDb, migrateDb, openDb } from "../db/client.ts";
import { inScope, SYSTEM } from "../db/scope.ts";
import { workspaces } from "../db/schema.ts";
import { migrateTo } from "../db/upgrade-fixture.ts";
import { registerMessages } from "../messages/index.ts";
import { base, limitRefusal } from "../rpc/context.ts";
import { router } from "../rpc/router.ts";
import { emptyContext, limitOn } from "../runners/test-support.ts";

const refused = { code: "FORBIDDEN", message: "Self-hosted version is restricted to one workspace", data: { key: "workspace.selfHostedLimit" } };

test("the first workspace is created by setup, and a second is refused with FORBIDDEN and the limit's text", async () => {
  const context = await emptyContext();
  await limitOn(context.db);
  await call(router.auth.setup, { name: "Ada", email: "ada@example.com", password: "correct horse battery", setupCode: context.setupCode }, { context });
  const [first] = await context.db.select().from(workspaces);
  expect(first).toBeDefined();
  // Whichever procedure's write hits the limit answers with it.
  const second = base.handler(() => inScope(SYSTEM, () => context.db.insert(workspaces).values({ id: "second", organizationId: first!.organizationId })));
  await expect(call(second, undefined, { context })).rejects.toMatchObject(refused);
  expect(await context.db.select({ id: workspaces.id }).from(workspaces)).toEqual([{ id: first!.id }]);
});

test("an install that already has two workspaces keeps both after the migration and refuses a third", async () => {
  const db = await openDb("pglite://memory");
  onTestFinished(() => closeDb(db));
  await migrateTo(db, "0108_idle_chats");
  await db.execute(sql`insert into organizations (id) values ('org')`);
  await db.execute(sql`insert into workspaces (id, organization_id) values ('a', 'org'), ('b', 'org')`);
  await migrateDb(db);
  expect((await db.select({ id: workspaces.id }).from(workspaces).orderBy(workspaces.id)).map((w) => w.id)).toEqual(["a", "b"]);
  await expect(db.insert(workspaces).values({ id: "c", organizationId: "org" })).rejects.toMatchObject({ cause: { code: "P0D01", message: "workspace.selfHostedLimit" } });
});

test("a refusal names its message key; one the server doesn't know, or another error, is left as it is", () => {
  const p0d01 = (key: string) => ({ cause: { code: "P0D01", message: key } });
  expect(limitRefusal(p0d01("workspace.selfHostedLimit"))).toMatchObject(refused);
  expect(limitRefusal(p0d01("workspace.unknownLimit"))).toBeUndefined();
  expect(limitRefusal({ cause: { code: "23505", message: "workspace.selfHostedLimit" } })).toBeUndefined();
  registerMessages("en", { "limits.testOnly": "A registered limit" });
  expect(limitRefusal(p0d01("limits.testOnly"))).toMatchObject({ code: "FORBIDDEN", message: "A registered limit", data: { key: "limits.testOnly" } });
});
