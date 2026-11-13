// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { ToolAsk } from "./ToolAsk.tsx";

afterEach(cleanup);

const actions = [
  { name: "search", description: "Finds messages.", readOnly: true, permission: "run" as const },
  { name: "send", description: "Sends a message.", readOnly: false, permission: "ask" as const },
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
  expect(seen).toHaveBeenLastCalledWith("send", "run");
  await user.click(screen.getByRole("switch", { name: "Ask before Mail search" }));
  expect(seen).toHaveBeenLastCalledWith("search", "ask");
  rerender(<ToolAsk tool="Mail" actions={actions} onChange={seen} busy />);
  expect((screen.getByRole("switch", { name: "Ask before Mail send" }) as HTMLInputElement).disabled).toBe(true);
});

test("ToolAsk says so when a tool lists no action", () => {
  render(<ToolAsk tool="Mail" actions={[]} onChange={() => {}} />);
  expect(screen.getByText("No actions listed.")).toBeTruthy();
});


test("disabled actions hide the Ask switch and re-enable as Ask, including read-only actions", async () => {
  const change = vi.fn();
  const off = [{ ...actions[0]!, permission: "off" as const }];
  const { rerender } = render(<ToolAsk tool="Mail" actions={off} onChange={change} />);
  const user = userEvent.setup();
  await user.click(screen.getByText("1 action, 0 ask before use, 1 off"));
  expect(screen.queryByRole("switch")).toBeNull();
  const enable = screen.getByRole("checkbox", { name: "Enable Mail search" }) as HTMLInputElement;
  expect(enable.checked).toBe(false);
  await user.click(enable);
  expect(change).toHaveBeenLastCalledWith("search", "ask");
  rerender(<ToolAsk tool="Mail" actions={[actions[0]!]} onChange={change} />);
  await user.click(screen.getByRole("checkbox", { name: "Enable Mail search" }));
  expect(change).toHaveBeenLastCalledWith("search", "off");
});
