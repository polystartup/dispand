// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { Overridden } from "./Overridden.tsx";

afterEach(cleanup);

const LABELS = { name: "Name", systemPrompt: "Instructions" };

test("a plugin's element says whose it is and that an update follows what wasn't changed", () => {
  render(<Overridden plugin="law-firm" overridden={[]} labels={LABELS} busy={false} onReset={() => {}} />);
  expect(screen.getByText(/It is law-firm's/).textContent).toMatch(/An update of the plugin replaces what you haven't changed/);
  expect(screen.queryByRole("button")).toBeNull();
});

test("each field its owner changed is named, with the way back to the plugin's value", async () => {
  const reset = vi.fn();
  render(<Overridden plugin="law-firm" overridden={["systemPrompt", "toolIds"]} labels={LABELS} busy={false} onReset={reset} />);
  const items = screen.getAllByRole("listitem");
  // A field with no label here still reads, by its own name.
  expect(items.map((i) => i.textContent)).toEqual(["Instructions: yours, kept through updatesReset to the plugin's", "toolIds: yours, kept through updatesReset to the plugin's"]);
  await userEvent.setup().click(screen.getByRole("button", { name: "Reset Instructions to the plugin's" }));
  expect(reset).toHaveBeenCalledWith("systemPrompt");
});
