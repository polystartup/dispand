// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { needsReview, UpdatePlan, type UpdateAddition, type UpdateChange, type UpdateConflict } from "./PluginUpdate.tsx";

afterEach(cleanup);

const at = (kind: UpdateChange["kind"], name: string, field: string) => ({ key: `${kind}:${name}:${field}`, kind, id: name, name, field });
const conflicts: UpdateConflict[] = [{ ...at("agent", "Drafting", "systemPrompt"), old: "Draft.", mine: "Mine.", next: "Draft well." }];
const changes: UpdateChange[] = [
  { ...at("agent", "Matter upkeep", "toolIds"), class: "widening", before: [], after: ["tool_1"] },
  { ...at("tool", "case-law", "url"), class: "widening", before: "https://a.example/mcp", after: "https://b.example/mcp" },
  { ...at("agent", "Intake", "systemPrompt"), class: "wording", before: "Read.", after: "Read each email." },
  { ...at("skill", "law-firm", "file:legal-research/SKILL.md"), class: "wording", before: "Old.", after: "New." },
  { ...at("agent", "Drafting", "dataTables"), class: "silent", before: ["tbl_1"], after: [] },
];
const names = { tool_1: "case-law", tbl_1: "Research" };

test("an update needs the owner's eyes for a conflict, a widening change or a change of wording, and for nothing else", () => {
  expect(needsReview({ conflicts: [], changes: [changes[4]!] })).toBe(false);
  expect(needsReview({ conflicts: [], changes: [] })).toBe(false);
  expect(needsReview({ conflicts, changes: [] })).toBe(true);
  expect(needsReview({ conflicts: [], changes: [changes[2]!] })).toBe(true);
  expect(needsReview({ conflicts: [], changes: [changes[0]!] })).toBe(true);
});

test("a conflict shows the three values and keeps the owner's unless they take the plugin's", async () => {
  const take = vi.fn();
  render(<UpdatePlan conflicts={conflicts} changes={[]} names={names} take={[]} busy={false} onTake={take} />);
  const conflict = screen.getByRole("group", { name: "Drafting: Instructions" });
  for (const text of ["Draft.", "Mine.", "Draft well."]) expect(conflict.textContent).toContain(text);
  expect((within(conflict).getByRole("radio", { name: "Keep mine" }) as HTMLInputElement).checked).toBe(true);
  await userEvent.click(within(conflict).getByRole("radio", { name: "Take the plugin's" }));
  expect(take).toHaveBeenCalledWith("agent:Drafting:systemPrompt", true);
});

test("what an agent gains and where a tool's calls go are listed by name; wording is one line that opens; the rest is a count", async () => {
  render(<UpdatePlan conflicts={[]} changes={changes} names={names} take={[]} busy={false} onTake={() => {}} />);
  const widening = screen.getByRole("list", { name: "Changes that give more" });
  expect(within(widening).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
    "Matter upkeep · Tools: none → case-law",
    "case-law · URL: https://a.example/mcp → https://b.example/mcp",
  ]);
  const wording = screen.getByText("2 wording changes");
  // Closed: the texts are there to read, not in the way.
  expect((wording.closest("details") as HTMLDetailsElement).open).toBe(false);
  await userEvent.click(wording);
  expect(wording.closest("details")!.textContent).toContain("Read each email.");
  expect(wording.closest("details")!.textContent).toContain("legal-research/SKILL.md");
  expect(screen.getByText("1 other change follows the plugin.")).toBeTruthy();
});

const additions: UpdateAddition[] = [
  { key: "primitive:Invoices", kind: "primitive", name: "Invoices", detail: "A table with 1 field" },
  { key: "agent:Billing", kind: "agent", name: "Billing", detail: "Prepares invoices." },
];

test("what a version adds is named, with where it gets made: the update has no box to tick for it", () => {
  expect(needsReview({ conflicts: [], changes: [], additions })).toBe(true);
  render(<UpdatePlan conflicts={[]} changes={[]} names={{}} take={[]} busy={false} onTake={() => {}} additions={additions} />);
  const added = screen.getByRole("list", { name: "New in this version" });
  expect(within(added).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Invoices · TableA table with 1 field", "Billing · AgentPrepares invoices."]);
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.getByText(/Set up opens afterwards/)).toBeTruthy();
});

test("release notes are the plugin's own words for its new version, as plain text, or the two commits when it has none", async () => {
  const { ReleaseNotes } = await import("./PluginUpdate.tsx");
  const { rerender } = render(<ReleaseNotes notes={{ from: "a".repeat(40), to: "b".repeat(40), version: "1.1.0", text: "## 1.1.0\n\n- <b>Shorter</b> replies." }} />);
  const notes = screen.getByText("Release notes for 1.1.0");
  await userEvent.click(notes);
  const body = notes.closest("details")!;
  // Shown as written: no markup reaches the page.
  expect(body.textContent).toContain("<b>Shorter</b> replies.");
  expect(body.querySelector("b")).toBeNull();
  rerender(<ReleaseNotes notes={{ from: "a".repeat(40), to: "b".repeat(40), version: null, text: null }} />);
  expect(screen.getByText("No release notes: from aaaaaaa to bbbbbbb.")).toBeTruthy();
});

test("a table's changes are boxes with their starting ticks; one that can't apply says why and can't be ticked", async () => {
  const { TableChanges, startingTicks } = await import("./PluginUpdate.tsx");
  const tick = vi.fn();
  const tables = [
    {
      tableId: "tbl_1",
      name: "Matters",
      changes: [
        { key: "add:Fee", kind: "add" as const, field: "Fee", ticked: true },
        { key: "remove:Conclusions", kind: "remove" as const, field: "Conclusions", ticked: false, loses: 42 },
        { key: "retype:Stage", kind: "retype" as const, field: "Stage", ticked: false, stale: "You changed this field" },
        { key: "add:Invoice", kind: "add" as const, field: "Invoice", ticked: false, waiting: "Invoices" },
      ],
    },
  ];
  expect(needsReview({ conflicts: [], changes: [], tables })).toBe(true);
  render(<TableChanges tables={tables} ticked={{ tbl_1: ["add:Fee"] }} busy={false} onTick={tick} />);
  const table = screen.getByRole("group", { name: "Matters" });
  expect((within(table).getByRole("checkbox", { name: /Add the field Fee/ }) as HTMLInputElement).checked).toBe(true);
  const removal = within(table).getByRole("checkbox", { name: /Remove the field Conclusions/ }) as HTMLInputElement;
  expect(removal.checked).toBe(false);
  expect(removal.closest("label")!.textContent).toContain("removes the values of 42 rows");
  expect((within(table).getByRole("checkbox", { name: /Change the type of Stage/ }) as HTMLInputElement).disabled).toBe(true);
  expect(table.textContent).toContain("You changed this field");
  expect(table.textContent).toContain("Waits for the table Invoices");
  expect(startingTicks(tables)).toEqual({ tbl_1: ["add:Fee"] });
  await userEvent.click(removal);
  expect(tick).toHaveBeenCalledWith("tbl_1", "remove:Conclusions");
});
