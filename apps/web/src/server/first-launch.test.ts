import { ORPCError } from "@orpc/server";
import { expect, test, vi } from "vitest";

const failure = vi.hoisted(() => ({ error: undefined as unknown }));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => ({}) }));
vi.mock("./app.ts", () => ({ getApp: async () => ({}) }));
vi.mock("@orpc/server", async (original) => ({
  ...(await original<typeof import("@orpc/server")>()),
  call: async () => {
    throw failure.error;
  },
}));
const { firstLaunch } = await import("./auth-state.ts");

test("Home's guard reads a refused organization as no first launch, so the page shows the refusal instead of an error", async () => {
  failure.error = new ORPCError("FORBIDDEN", { message: "This organization can't be used right now.", data: { key: "organization.refused", link: "/help", organizationId: "org_a" } });
  expect(await firstLaunch()).toBe(false);
});

test("any other failure of Home's guard still fails it", async () => {
  failure.error = new ORPCError("FORBIDDEN", { message: "Only a manager of this workspace can do this.", data: { key: "workspace.managerOnly" } });
  await expect(firstLaunch()).rejects.toBe(failure.error);
});
