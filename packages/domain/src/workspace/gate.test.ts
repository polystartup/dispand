import { expect, onTestFinished, test } from "vitest";
import { refusalOf, refuses, setTenancy, shared, type OrganizationRefusal } from "../db/scope.ts";
import { registerMessages } from "../messages/index.ts";
import { testDb } from "../runners/test-support.ts";
import { organizationRefusal, workspaceRefusal } from "./gate.ts";
import { organizations, workspaces } from "../db/schema.ts";
import type { Db } from "../db/client.ts";

const LINK = "/organization-settings?organization=org_refused";

/** The install refuses `org_refused` with `key` until the test ends. */
function refusing(db: Db, key = "organization.testRefused"): void {
  setTenancy(db, { ...shared, refusal: (organizationId): OrganizationRefusal | undefined => (organizationId === "org_refused" ? { key, link: LINK } : undefined) });
  onTestFinished(() => setTenancy(db, shared));
}

test("with no refusal on its tenancy, an install refuses no organization", async () => {
  const db = await testDb();
  expect([refuses(db), refusalOf(db, "org_refused"), organizationRefusal(db, "org_refused", "request")]).toEqual([false, undefined, undefined]);
  await db.insert(organizations).values({ id: "org_refused" });
  await db.insert(workspaces).values({ id: "ws_refused", organizationId: "org_refused" });
  expect(await workspaceRefusal(db, "ws_refused", "job_call")).toBeUndefined();
});

test("a refusal says the install's registered message, else the public one, with its link and organization", async () => {
  const db = await testDb();
  registerMessages("en", { "organization.testRefused": "This organization is paused by its install" });
  refusing(db);
  expect(refuses(db)).toBe(true);
  expect(refusalOf(db, "org_other")).toBeUndefined();
  expect(organizationRefusal(db, "org_other", "request")).toBeUndefined();
  expect(organizationRefusal(db, "org_refused", "request")).toMatchObject({
    code: "FORBIDDEN", message: "This organization is paused by its install", data: { key: "organization.testRefused", link: LINK, organizationId: "org_refused" },
  });
  refusing(db, "organization.unknownToThisServer");
  expect(organizationRefusal(db, "org_refused", "request")).toMatchObject({
    code: "FORBIDDEN", message: "This organization can't be used right now.", data: { key: "organization.refused", link: LINK, organizationId: "org_refused" },
  });
  await db.insert(organizations).values([{ id: "org_refused" }, { id: "org_other" }]);
  await db.insert(workspaces).values([{ id: "ws_refused", organizationId: "org_refused" }, { id: "ws_other", organizationId: "org_other" }]);
  expect(await workspaceRefusal(db, "ws_refused", "job_call")).toMatchObject({ data: { organizationId: "org_refused" } });
  expect(await workspaceRefusal(db, "ws_other", "job_call")).toBeUndefined();
});
