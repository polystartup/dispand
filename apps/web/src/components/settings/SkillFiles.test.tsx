// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { SkillFiles } from "./SkillFiles.tsx";

afterEach(cleanup);

const files = [
  { path: "pdf/SKILL.md", size: 120, overridden: null },
  { path: "pdf/fill.py", size: 14, overridden: "changed" as const },
  { path: "pdf/notes.md", size: 6, overridden: "added" as const },
];

test("a plugin's skill lists its files, says which are the owner's, and names the ones they removed", () => {
  render(<SkillFiles files={files} removed={["pdf/old.py"]} busy={false} onEdit={() => {}} onRemove={() => {}} onReset={() => {}} />);
  const rows = screen.getAllByRole("listitem");
  expect(rows.map((r) => r.querySelector("[data-path]")?.textContent)).toEqual(["pdf/SKILL.md", "pdf/fill.py", "pdf/notes.md", "pdf/old.py"]);
  expect(within(rows[0]!).queryByText(/yours/i)).toBeNull();
  expect(within(rows[1]!).getByText("Yours: changed")).toBeTruthy();
  expect(within(rows[2]!).getByText("Yours: added")).toBeTruthy();
  expect(within(rows[3]!).getByText("Removed by you")).toBeTruthy();
  // The plugin's own file has nothing to go back to; a removed one can only come back.
  expect(within(rows[0]!).queryByRole("button", { name: /Reset/ })).toBeNull();
  expect(within(rows[3]!).queryByRole("button", { name: /Edit|Remove/ })).toBeNull();
});

test("each file can be edited or removed, and an owner's change taken back", async () => {
  const [edit, remove, reset] = [vi.fn(), vi.fn(), vi.fn()];
  render(<SkillFiles files={files} removed={["pdf/old.py"]} busy={false} onEdit={edit} onRemove={remove} onReset={reset} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Edit pdf/SKILL.md" }));
  await user.click(screen.getByRole("button", { name: "Remove pdf/fill.py" }));
  await user.click(screen.getByRole("button", { name: "Reset pdf/fill.py to the plugin's" }));
  await user.click(screen.getByRole("button", { name: "Reset pdf/old.py to the plugin's" }));
  expect(edit).toHaveBeenCalledWith("pdf/SKILL.md");
  expect(remove).toHaveBeenCalledWith("pdf/fill.py");
  expect(reset.mock.calls).toEqual([["pdf/fill.py"], ["pdf/old.py"]]);
});
