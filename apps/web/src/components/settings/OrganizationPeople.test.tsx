// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({
  organization: { directory: vi.fn(), assign: vi.fn(), unassign: vi.fn(), archiveMember: vi.fn(), archived: vi.fn() },
  workspace: { people: vi.fn() },
}));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { OrganizationPeople } = await import("./OrganizationPeople.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const directory = {
  workspaces: [{ workspaceId: "eng", name: "Engineering" }, { workspaceId: "ops", name: "Operations" }],
  people: [
    { userId: "ada", name: "Ada", email: "ada@example.com", role: "owner", workspaces: [] },
    { userId: "pat", name: "Pat", email: "pat@example.com", role: "member", workspaces: [{ workspaceId: "eng", role: "manager" }] },
    // Restored: in the organization, no workspace role yet.
    { userId: "sam", name: "Sam", email: "sam@example.com", role: "member", workspaces: [] },
  ],
};

const mount = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <OrganizationPeople retentionDays={90} />
  </QueryClientProvider>,
);

test("every member shows with their workspace roles, someone with none included, and the owner can't be changed", async () => {
  fake.organization.directory.mockResolvedValue(directory);
  mount();
  const sam = (await screen.findByText("Sam")).closest("li")!;
  expect(sam.textContent).toContain("No role in any workspace yet.");
  const pat = screen.getByText("Pat").closest("li")!;
  expect(within(pat).getByText("Engineering · Workspace manager")).toBeTruthy();
  const ada = screen.getByText("Ada").closest("li")!;
  expect(ada.textContent).toContain("Has every right in every workspace.");
  expect(within(ada).queryByRole("button")).toBeNull();
});

test("the owner gives a restored person a role in a workspace, takes one away, and deletes after a confirmation", async () => {
  fake.organization.directory.mockResolvedValue(directory);
  fake.organization.assign.mockResolvedValue({ assigned: true });
  fake.organization.unassign.mockResolvedValue({ removed: true });
  fake.organization.archiveMember.mockResolvedValue({ archived: true });
  mount();
  const user = userEvent.setup();
  await screen.findByText("Sam");
  await user.selectOptions(screen.getByLabelText("Workspace for Sam"), "ops");
  await user.selectOptions(screen.getByLabelText("Role for Sam"), "manager");
  await user.click(screen.getByRole("button", { name: "Add Sam to the workspace" }));
  expect(fake.organization.assign.mock.calls[0]![0]).toEqual({ userId: "sam", workspaceId: "ops", role: "manager" });
  expect(await screen.findByText("Sam added to Operations.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Remove Pat from Engineering" }));
  expect(fake.organization.unassign.mock.calls[0]![0]).toEqual({ userId: "pat", workspaceId: "eng" });
  expect(await screen.findByText("Pat removed from Engineering.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Delete Sam from the organization" }));
  const dialog = screen.getByRole("dialog", { name: "Delete Sam?" });
  expect(within(dialog).getByText(/after 90 days/)).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: "Delete" }));
  expect(fake.organization.archiveMember.mock.calls[0]![0]).toEqual({ userId: "sam" });
  expect(await screen.findByText("Sam deleted.")).toBeTruthy();
});

test("a refusal says why", async () => {
  fake.organization.directory.mockResolvedValue(directory);
  fake.organization.archiveMember.mockRejectedValue(new Error("This person belongs to another organization too."));
  mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Delete Pat from the organization" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
  expect((await screen.findByRole("alert")).textContent).toBe("This person belongs to another organization too.");
});
