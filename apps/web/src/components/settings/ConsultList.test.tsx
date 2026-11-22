// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import "../../test/jsdom-shims.ts";
import { ConsultList, type ConsultEntry, type ConsultMode } from "./ConsultList.tsx";

afterEach(cleanup);

const agents = [
  { id: "agent_self", name: "Product owner", bundles: ["data"] },
  { id: "agent_arch", name: "Architect", bundles: ["data"] },
  { id: "agent_sec", name: "Security", bundles: [] },
  { id: "agent_asst", name: "Assistant", bundles: ["data", "configure"] },
];

function Harness({ initial, mode: initialMode = "whitelist", others = agents, onChange = () => {}, onMode = () => {} }: { initial: ConsultEntry[]; mode?: ConsultMode; others?: typeof agents; onChange?: (e: ConsultEntry[]) => void; onMode?: (m: ConsultMode) => void }) {
  const [entries, setEntries] = useState(initial);
  const [mode, setMode] = useState(initialMode);
  return (
    <ConsultList
      agentId="agent_self"
      bundles={["data"]}
      mode={mode}
      entries={entries}
      agents={others}
      onModeChange={(m) => {
        setMode(m);
        onMode(m);
      }}
      onChange={(e) => {
        setEntries(e);
        onChange(e);
      }}
    />
  );
}

describe("ConsultList", () => {
  test("disabled with an empty list: the agent asks no agents", () => {
    render(<Harness initial={[]} mode="disabled" />);
    expect(screen.getByRole("radio", { name: /^Disabled/ })).toHaveProperty("checked", true);
    expect(screen.getByText("This agent doesn't ask agents.")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  test("disabled with a list kept: the picks show greyed and read-only, with how to use them again", () => {
    render(<Harness initial={[{ agentId: "agent_arch" }]} mode="disabled" />);
    expect(screen.getByText("Architect")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove Architect" })).toBeNull();
    expect(screen.getByText("Turn on Whitelist to use these again.")).toBeTruthy();
  });

  test("auto: any same-side agent, with the count loaded", () => {
    render(<Harness initial={[{ agentId: "agent_arch" }]} mode="auto" />);
    expect(screen.getByText("Any agent of this workspace on its side")).toBeTruthy();
    expect(screen.getByText("2 agents offered.")).toBeTruthy();
    expect(screen.queryByText(/^Only the first 50/)).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  test("auto above 50 agents: only the first 50 are offered", () => {
    const many = [agents[0]!, ...Array.from({ length: 51 }, (_, i) => ({ id: `agent_${i}`, name: `Agent ${i}`, bundles: ["data"] }))];
    render(<Harness initial={[]} mode="auto" others={many} />);
    expect(screen.getByText("50 agents offered.")).toBeTruthy();
    expect(screen.getByText("Only the first 50 are offered. Pick them instead.")).toBeTruthy();
  });

  test("whitelist with an empty list: no agents, and the add picker offers only same-side agents, never itself", async () => {
    render(<Harness initial={[]} />);
    expect(screen.getByText("It can steer this agent with its questions, and its answers may quote what it reads in tables this agent can't.")).toBeTruthy();
    expect(screen.getByText("No agents.")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("combobox", { name: "Add an agent to consult" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Architect", "Security"]);
  });

  test("whitelist: one row per pick with Remove and no switch; an entry across the configure line shows inactive", async () => {
    const seen = vi.fn();
    render(<Harness initial={[{ agentId: "agent_asst" }]} onChange={seen} />);
    const user = userEvent.setup();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText(/^Inactive:/).closest("li")!.textContent).toContain("Assistant");
    await user.click(screen.getByRole("combobox", { name: "Add an agent to consult" }));
    await user.click(screen.getByRole("option", { name: "Architect" }));
    expect(seen).toHaveBeenLastCalledWith([{ agentId: "agent_asst" }, { agentId: "agent_arch" }]);
    await user.click(screen.getByRole("button", { name: "Remove Assistant" }));
    expect(seen).toHaveBeenLastCalledWith([{ agentId: "agent_arch" }]);
  });

  test("the mode control switches between the three modes and keeps the picks", async () => {
    const seen = vi.fn();
    render(<Harness initial={[{ agentId: "agent_arch" }]} onMode={seen} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: /^Auto/ }));
    expect(seen).toHaveBeenLastCalledWith("auto");
    await user.click(screen.getByRole("radio", { name: /^Whitelist/ }));
    expect(screen.getByRole("button", { name: "Remove Architect" })).toBeTruthy();
  });
});
