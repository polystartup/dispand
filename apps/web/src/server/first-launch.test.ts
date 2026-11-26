import { ORPCError } from "@orpc/server";
import { expect, test, vi } from "vitest";

const failure = vi.hoisted(() => ({ error: undefined as unknown, headers: undefined as Headers | undefined }));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => ({}) }));
vi.mock("./app.ts", () => ({ getApp: async () => ({}) }));
vi.mock("@orpc/server", async (original) => ({
  ...(await original<typeof import("@orpc/server")>()),
  call: async (_procedure: unknown, _input: unknown, { context }: { context: { headers: Headers } }) => {
    failure.headers = context.headers;
    if (failure.error) throw failure.error;
    return { assistant: null };
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

test("Home's guard asks in the tab's workspace, which a server function's request doesn't name", async () => {
  failure.error = undefined;
  expect(await firstLaunch({ organizationId: "org_b", workspaceId: "ws_b" })).toBe(true);
  expect([failure.headers!.get("dispand-organization"), failure.headers!.get("dispand-workspace")]).toEqual(["org_b", "ws_b"]);
});
