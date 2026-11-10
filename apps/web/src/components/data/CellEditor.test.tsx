// @vitest-environment jsdom
import type { Cell, FieldSchema } from "@dispand/domain/data/fields";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { CellEditor } from "./CellEditor.tsx";

afterEach(cleanup);

const field = (type: FieldSchema["type"], choices: FieldSchema["choices"] = []): FieldSchema => ({ id: "f", name: "Field", type, choices });

function setup(f: FieldSchema, value: Cell = null) {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  render(<CellEditor field={f} value={value} onCommit={onCommit} onCancel={onCancel} />);
  return { onCommit, onCancel, user: userEvent.setup() };
}

test("number editor commits a number", async () => {
  const { onCommit, user } = setup(field("number"));
  await user.keyboard("1 234,5{Enter}");
  expect(onCommit).toHaveBeenCalledWith(1234.5, "Enter");
});

test("an invalid number shows why and does not commit", async () => {
  const { onCommit, user } = setup(field("number"));
  await user.keyboard("lots{Enter}");
  expect(onCommit).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain("expected a number");
});

test("Escape cancels", async () => {
  const { onCommit, onCancel, user } = setup(field("text"), "Old");
  await user.keyboard("{Control>}a{/Control}New{Escape}");
  expect(onCancel).toHaveBeenCalled();
  expect(onCommit).not.toHaveBeenCalled();
});

test("Tab commits and moves on", async () => {
  const { onCommit, user } = setup(field("text"));
  await user.keyboard("Dispand{Tab}");
  expect(onCommit).toHaveBeenCalledWith("Dispand", "Tab");
});

test("long text commits on Cmd+Enter, not Enter", async () => {
  const { onCommit, user } = setup(field("long-text"));
  await user.keyboard("one{Enter}two");
  expect(onCommit).not.toHaveBeenCalled();
  await user.keyboard("{Meta>}{Enter}{/Meta}");
  expect(onCommit).toHaveBeenCalledWith("one\ntwo", undefined);
});

test("single-select commits the choice id, and Clear empties it", async () => {
  const f = field("single-select", [
    { id: "c_idea", label: "Idea" },
    { id: "c_live", label: "Live" },
  ]);
  const { onCommit, user } = setup(f, "c_idea");
  await user.click(screen.getByRole("option", { name: "Live" }));
  expect(onCommit).toHaveBeenCalledWith("c_live");
  await user.click(screen.getByRole("button", { name: "Clear" }));
  expect(onCommit).toHaveBeenLastCalledWith(null);
});
