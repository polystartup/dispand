// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { ToolAsk } from "./ToolAsk.tsx";

afterEach(cleanup);

const actions = [
  { name: "search", description: "Finds messages.", readOnly: true, ask: false },
  { name: "send", description: "Sends a message.", readOnly: false, ask: true },
];

test("ToolAsk says how many actions ask, and shows each with the tool's own read-only claim", async () => {
  render(<ToolAsk tool="Mail" actions={actions} onChange={() => {}} />);
  expect(screen.getByText("2 actions, 1 asks before use")).toBeTruthy();
  await userEvent.setup().click(screen.getByText("2 actions, 1 asks before use"));
  expect((screen.getByRole("switch", { name: "Ask before Mail search" }) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole("switch", { name: "Ask before Mail send" }) as HTMLInputElement).checked).toBe(true);
  // The hint is the tool's claim, said as one, and only where the tool makes it.
  expect(screen.getAllByText("read-only, according to the tool")).toHaveLength(1);
  expect(screen.getByText("Finds messages.")).toBeTruthy();
});

test("ToolAsk hands each change over, and holds the switches while one is being saved", async () => {
  const seen = vi.fn();
  const { rerender } = render(<ToolAsk tool="Mail" actions={actions} onChange={seen} />);
  const user = userEvent.setup();
  await user.click(screen.getByText("2 actions, 1 asks before use"));
  await user.click(screen.getByRole("switch", { name: "Ask before Mail send" }));
  expect(seen).toHaveBeenLastCalledWith("send", false);
  await user.click(screen.getByRole("switch", { name: "Ask before Mail search" }));
  expect(seen).toHaveBeenLastCalledWith("search", true);
  rerender(<ToolAsk tool="Mail" actions={actions} onChange={seen} busy />);
  expect((screen.getByRole("switch", { name: "Ask before Mail send" }) as HTMLInputElement).disabled).toBe(true);
});

test("ToolAsk says so when a tool lists no action", () => {
  render(<ToolAsk tool="Mail" actions={[]} onChange={() => {}} />);
  expect(screen.getByText("No actions listed.")).toBeTruthy();
});
