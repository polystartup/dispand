// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const grid = vi.hoisted(() => ({ broken: true }));
vi.mock("../../lib/api.ts", async () => (await import("../../test/fake-api.ts")).apiModule());
vi.mock("../widgets/GridWidget.tsx", () => ({
  GridWidget: ({ widget }: { widget: { title: string } }) => {
    if (grid.broken && widget.title === "Broken") throw new Error("secret detail");
    return <p>{widget.title} shown</p>;
  },
}));
// The other widget types load their own queries: this test only needs grids.
vi.mock("../widgets/TableWidget.tsx", () => ({ TableWidget: () => null }));
vi.mock("../widgets/TriggerWidget.tsx", () => ({ TriggerWidget: () => null }));
vi.mock("../widgets/WorkflowFormWidget.tsx", () => ({ WorkflowFormWidget: () => null }));
const { Dashboard } = await import("./Dashboard.tsx");

afterEach(cleanup);

const at = { x: 0, y: 0, w: 4, h: 4 };
const widget = (id: string, title: string) => ({ id, type: "grid", title, layout: { lg: at, md: at, sm: at, xs: at, xxs: at } }) as never;

test("a widget that throws while rendering fails alone, and its retry renders it again", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Dashboard pageId="p" widgets={[widget("w1", "Broken"), widget("w2", "Fine")]} editing={false} />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Fine shown")).toBeTruthy();
  expect((await screen.findByRole("alert")).textContent).toContain("This widget failed to load.");
  expect(screen.queryByText(/secret detail/)).toBeNull();
  grid.broken = false;
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Broken shown")).toBeTruthy();
});
