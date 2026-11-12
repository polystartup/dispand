// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import "../../test/jsdom-shims.ts";
import { ConsultList, type ConsultEntry } from "./ConsultList.tsx";

afterEach(cleanup);

const agents = [
  { id: "agent_self", name: "Product owner", bundles: ["data"] },
  { id: "agent_arch", name: "Architect", bundles: ["data"] },
  { id: "agent_sec", name: "Security", bundles: [] },
  { id: "agent_asst", name: "Assistant", bundles: ["data", "configure"] },
];

function Harness({ initial, onChange }: { initial: ConsultEntry[]; onChange: (e: ConsultEntry[]) => void }) {
  const [entries, setEntries] = useState(initial);
  return (
    <ConsultList
      agentId="agent_self"
      bundles={["data"]}
      entries={entries}
      agents={agents}
      onChange={(e) => {
        setEntries(e);
        onChange(e);
      }}
    />
  );
}

test("the list says what a consult can do, and offers only agents on this agent's side of configure, never itself", async () => {
  render(<Harness initial={[]} onChange={() => {}} />);
  expect(screen.getByText("It can steer this agent with its questions, and its answers may quote what it reads in tables this agent can't.")).toBeTruthy();
  expect(screen.getByText("No agents.")).toBeTruthy();
  await userEvent.setup().click(screen.getByRole("combobox", { name: "Add an agent to consult" }));
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Architect", "Security"]);
});

test("an entry is added unflagged, flagged, and removed", async () => {
  const seen = vi.fn();
  render(<Harness initial={[]} onChange={seen} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Add an agent to consult" }));
  await user.click(screen.getByRole("option", { name: "Architect" }));
  expect(seen).toHaveBeenLastCalledWith([{ agentId: "agent_arch", ask: false }]);
  await user.click(screen.getByRole("switch", { name: "Ask before consulting Architect" }));
  expect(seen).toHaveBeenLastCalledWith([{ agentId: "agent_arch", ask: true }]);
  await user.click(screen.getByRole("button", { name: "Remove Architect" }));
  expect(seen).toHaveBeenLastCalledWith([]);
});

test("an entry across the configure line is shown inactive, and can still be removed", () => {
  render(<Harness initial={[{ agentId: "agent_asst", ask: false }, { agentId: "agent_arch", ask: false }]} onChange={() => {}} />);
  expect(screen.getAllByText(/^Inactive:/)).toHaveLength(1);
  expect(screen.getByText(/^Inactive:/).closest("li")!.textContent).toContain("Assistant");
  expect(screen.getByRole("button", { name: "Remove Assistant" })).toBeTruthy();
});
