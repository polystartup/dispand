// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ plugins: { update: vi.fn(), uninstall: vi.fn() }, skills: {}, tools: {}, agents: {} }));
vi.mock("../../lib/api.ts", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { api: fake, orpc: createTanstackQueryUtils(fake as never) };
});
const { PluginRow } = await import("./PluginRow.tsx");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const none = { skills: [], mcpServers: [], agents: [] };
const base = { description: "", updatedAt: new Date(), skills: [], tools: [], agents: [], tables: [], fields: [], triggers: [], available: none, notImported: [] };

function mount(plugin: Parameters<typeof PluginRow>[0]["plugin"]) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ul>
        <PluginRow plugin={plugin} />
      </ul>
    </QueryClientProvider>,
  );
}

test("a generated plugin lists what was created, by kind, has nothing to update, and says removing it keeps them", async () => {
  fake.plugins.uninstall.mockResolvedValue(undefined);
  mount({
    ...base,
    id: "plugin_1",
    name: "Generated: Acme Law",
    source: "generated",
    marketplace: null,
    url: null,
    sha: null,
    tables: [{ id: "t1", name: "Matters" }],
    fields: [{ id: "f1", name: "Matters.Status" }],
    agents: [{ id: "a1", name: "Clerk" }],
    triggers: [{ id: "tr1", name: "Clerk: Ask" }],
    tools: [{ id: "tool1", name: "Search" }],
  });
  const row = screen.getByRole("listitem", { name: "Generated: Acme Law" });
  for (const text of ["Matters", "Matters.Status", "Clerk", "Clerk: Ask", "Search"]) expect(row.textContent).toContain(text);
  expect(row.textContent).toMatch(/removing it keeps them/);
  expect(row.textContent).not.toMatch(/Skills:/);
  expect(screen.queryByRole("button", { name: "Update Generated: Acme Law" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Remove Generated: Acme Law" }));
  expect(fake.plugins.uninstall.mock.calls[0]![0]).toEqual({ id: "plugin_1" });
});

test("a marketplace plugin reads as before: where it came from, its commit, Update", () => {
  mount({ ...base, id: "plugin_2", name: "superpowers", source: "marketplace", marketplace: "acme", url: "https://example.com/p.git", sha: "0123456789abcdef", skills: [{ name: "tdd", description: "" }] });
  const row = screen.getByRole("listitem", { name: "superpowers" });
  expect(row.textContent).toContain("From acme · 0123456");
  expect(row.textContent).toContain("tdd");
  expect(screen.getByRole("button", { name: "Update superpowers" })).toBeTruthy();
});
