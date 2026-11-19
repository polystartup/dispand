// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import type { ProposalView } from "./ProposalItems.tsx";
import { RecordedProposalScope } from "./RecordedProposalScope.tsx";

afterEach(cleanup);

const item = { tool: "agents_create", input: { name: "Researcher" }, refs: [], used: false };
const proposal: ProposalView = { id: "prop_1", status: "approved", items: [item], names: {} };

test("recorded failures stay visible and only count settled refusals", async () => {
  const mixed = { ...proposal, items: [
    { ...item, used: true, failed: true },
    { ...item, used: true, pending: true },
    { ...item, used: true },
    item,
  ] };
  render(<RecordedProposalScope proposal={mixed} />);
  const trigger = screen.getByRole("button", { name: "4 proposed changes" });
  expect(screen.getByText("1 change was refused.")).toBeTruthy();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("list")).toBeNull();
  const user = userEvent.setup();
  await user.tab();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("list", { name: "What is proposed" }).children).toHaveLength(4);
  await user.keyboard("{Escape}");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
});

test("a previously visible scope stays open until closed and later updates preserve that choice", async () => {
  const view = render(<RecordedProposalScope proposal={proposal} defaultOpen />);
  const trigger = screen.getByRole("button", { name: "1 proposed change" });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  await userEvent.setup().click(trigger);
  view.rerender(<RecordedProposalScope proposal={{ ...proposal, items: [{ ...item, used: true, failed: true }] }} defaultOpen />);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByText("1 change was refused.")).toBeTruthy();
});
