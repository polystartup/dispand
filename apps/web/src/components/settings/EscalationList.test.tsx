// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import "../../test/jsdom-shims.ts";
import type { ConsultMode } from "./ConsultList.tsx";
import { EscalationList, type EscalationEntry, type Member } from "./EscalationList.tsx";

afterEach(cleanup);

const members: Member[] = [
  { id: "user_ann", name: "Ann", profile: true },
  { id: "user_bob", name: "Bob", profile: false },
  { id: "user_cid", name: "Cid", profile: true },
];

function Harness({ initial, mode: initialMode = "whitelist", people = members, onChange = () => {}, onMode = () => {} }: { initial: EscalationEntry[]; mode?: ConsultMode; people?: Member[]; onChange?: (e: EscalationEntry[]) => void; onMode?: (m: ConsultMode) => void }) {
  const [entries, setEntries] = useState(initial);
  const [mode, setMode] = useState(initialMode);
  return (
    <EscalationList
      mode={mode}
      entries={entries}
      members={people}
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

describe("EscalationList", () => {
  test("disabled with an empty list: the agent asks no people", () => {
    render(<Harness initial={[]} mode="disabled" />);
    expect(screen.getByRole("radio", { name: /^Disabled/ })).toHaveProperty("checked", true);
    expect(screen.getByText("This agent doesn't ask people.")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  test("disabled with a list kept: the picks show greyed and read-only, with how to use them again", () => {
    render(<Harness initial={[{ userId: "user_ann" }]} mode="disabled" />);
    expect(screen.getByText("Ann")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove Ann" })).toBeNull();
    expect(screen.getByText("Turn on Whitelist to use these again.")).toBeTruthy();
  });

  test("auto: any member with a profile, with the count loaded, and above 50 only the first 50", () => {
    render(<Harness initial={[]} mode="auto" />);
    expect(screen.getByText("Any member with a profile")).toBeTruthy();
    expect(screen.getByText("2 people offered.")).toBeTruthy();
    expect(screen.queryByText(/^Only the first 50/)).toBeNull();
    cleanup();
    render(<Harness initial={[]} mode="auto" people={Array.from({ length: 51 }, (_, i) => ({ id: `user_${i}`, name: `P ${i}`, profile: true }))} />);
    expect(screen.getByText("50 people offered.")).toBeTruthy();
    expect(screen.getByText("Only the first 50 are offered. Pick them instead.")).toBeTruthy();
  });

  test("whitelist with an empty list: no people, and the add picker offers current members", async () => {
    render(<Harness initial={[]} />);
    expect(screen.getByText("No people.")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("combobox", { name: "Add a person to ask" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Ann", "Bob", "Cid"]);
  });

  test("whitelist: one row per pick with Remove and no switch; someone who left, and someone with no profile, say so", async () => {
    const seen = vi.fn();
    render(<Harness initial={[{ userId: "user_gone", name: "Gus", member: false, profile: true }, { userId: "user_bob" }]} onChange={seen} />);
    const user = userEvent.setup();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("No longer a member").closest("li")!.textContent).toContain("Gus");
    expect(screen.getByText("No profile yet: agents can't tell what they know.").closest("li")!.textContent).toContain("Bob");
    await user.click(screen.getByRole("combobox", { name: "Add a person to ask" }));
    await user.click(screen.getByRole("option", { name: "Ann" }));
    expect(seen).toHaveBeenLastCalledWith([{ userId: "user_gone", name: "Gus", member: false, profile: true }, { userId: "user_bob" }, { userId: "user_ann" }]);
    await user.click(screen.getByRole("button", { name: "Remove Gus" }));
    expect(seen).toHaveBeenLastCalledWith([{ userId: "user_bob" }, { userId: "user_ann" }]);
  });
});
