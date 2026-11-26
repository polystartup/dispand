import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { inScope, SYSTEM } from "../db/scope.ts";
import { audit, marketplaces, organizationMembers, user, workspaces } from "../db/schema.ts";
import { BUILT_IN_MARKETPLACES } from "../plugins/marketplace.ts";
import { router } from "../rpc/router.ts";
import { limitOn, ownerContext, personContext, recordingDb } from "../runners/test-support.ts";
import { ORGANIZATION_HEADER, WORKSPACE_HEADER } from "./authorize.ts";
import { bootstrapOrganization } from "./lifecycle.ts";

const named = <C extends { headers: Headers }>(context: C, headers: Record<string, string>) => ({ ...context, headers: new Headers([...context.headers, ...Object.entries(headers)]) });

test("the organization's owner creates a workspace with its marketplaces; a member can't", async () => {
  const owner = await ownerContext();
  const { db, organizationId } = owner;
  const pat = await personContext(owner, "pat", "manager");
  await expect(call(router.workspace.create, { name: "Finance" }, { context: named(pat, { [ORGANIZATION_HEADER]: organizationId }) })).rejects.toMatchObject({ code: "NOT_FOUND" });
  const { workspaceId } = await call(router.workspace.create, { name: "Finance" }, { context: named(owner, { [ORGANIZATION_HEADER]: organizationId }) });
  expect(await db.select({ name: workspaces.name, organizationId: workspaces.organizationId }).from(workspaces).where(eq(workspaces.id, workspaceId))).toEqual([{ name: "Finance", organizationId }]);
  expect((await db.select().from(marketplaces).where(eq(marketplaces.workspaceId, workspaceId))).length).toBeGreaterThan(0);
  expect(await db.select({ workspaceId: audit.workspaceId }).from(audit).where(eq(audit.action, "workspace.created"))).toEqual([{ workspaceId }]);
});

test("a second workspace is refused with FORBIDDEN and exactly the self-hosted limit's text, and nothing is written", async () => {
  const owner = await ownerContext();
  await limitOn(owner.db);
  await expect(call(router.workspace.create, { name: "Finance" }, { context: named(owner, { [ORGANIZATION_HEADER]: owner.organizationId }) }))
    .rejects.toMatchObject({ code: "FORBIDDEN", message: "Self-hosted version is restricted to one workspace", data: { key: "workspace.selfHostedLimit" } });
  expect(await owner.db.select({ id: workspaces.id }).from(workspaces)).toEqual([{ id: owner.workspaceId }]);
  expect(await owner.db.select().from(audit).where(eq(audit.action, "workspace.created"))).toEqual([]);
});

test("a manager renames their workspace; a member can't", async () => {
  const owner = await ownerContext();
  const where = { [ORGANIZATION_HEADER]: owner.organizationId, [WORKSPACE_HEADER]: owner.workspaceId };
  const manager = named(await personContext(owner, "pat", "manager"), where);
  const member = named(await personContext(owner, "sam", "member"), where);
  await expect(call(router.workspace.rename, { name: "Ops" }, { context: member })).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(await call(router.workspace.rename, { name: " Ops " }, { context: manager })).toEqual({ name: "Ops" });
  expect(await owner.db.select({ name: workspaces.name }).from(workspaces)).toEqual([{ name: "Ops" }]);
  expect(await owner.db.select({ actor: audit.actor }).from(audit).where(eq(audit.action, "workspace.renamed"))).toEqual([{ actor: { type: "user", userId: "pat" } }]);
});

test("bootstrapOrganization with preallocated ids writes no auth table", async () => {
  const { db, statements } = await recordingDb();
  await db.insert(user).values({ id: "ada", name: "Ada", email: "ada@example.com" });
  statements.length = 0;
  await inScope(SYSTEM, () => db.transaction((tx) => bootstrapOrganization(tx, { userId: "ada", organizationId: "org_given", workspaceId: "ws_given", name: "Northwind" })));
  expect(statements.filter((s) => /"(user|account|session|verification)"/.test(s))).toEqual([]);
  expect(await db.select({ organizationId: organizationMembers.organizationId, role: organizationMembers.role }).from(organizationMembers)).toEqual([{ organizationId: "org_given", role: "owner" }]);
  expect(await db.select({ id: workspaces.id, organizationId: workspaces.organizationId }).from(workspaces)).toEqual([{ id: "ws_given", organizationId: "org_given" }]);
});

test("bootstrapOrganization seeds exactly the built-in marketplaces in the first workspace", async () => {
  const { db } = await recordingDb();
  await db.insert(user).values({ id: "ada", name: "Ada", email: "ada@example.com" });
  await inScope(SYSTEM, () => db.transaction((tx) => bootstrapOrganization(tx, { userId: "ada", organizationId: "org_given", workspaceId: "ws_given" })));
  const rows = await db.select({ name: marketplaces.name, url: marketplaces.url, builtIn: marketplaces.builtIn, ownerId: marketplaces.ownerId, workspaceId: marketplaces.workspaceId }).from(marketplaces);
  const expected = BUILT_IN_MARKETPLACES.map((m) => ({ name: m.name, url: m.url, builtIn: true, ownerId: "ada", workspaceId: "ws_given" }));
  expect(rows).toHaveLength(expected.length);
  expect(rows).toEqual(expect.arrayContaining(expected));
});
