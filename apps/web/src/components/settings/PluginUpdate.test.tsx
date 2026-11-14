// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { addOf, needsReview, UpdatePlan, type UpdateAddition, type UpdateChange, type UpdateConflict } from "./PluginUpdate.tsx";

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
  { key: "agent:Billing", kind: "agent", name: "Billing", detail: "Prepares invoices.", harness: "cloud" },
  { key: "trigger:Invoice due", kind: "trigger", name: "Invoice due", detail: "Starts Jobs of Billing" },
  { key: "skill:billing", kind: "skill", name: "billing", detail: "Bills." },
];
const harnesses = [{ id: "h_cli", name: "Codex", type: "cli" }, { id: "h_cloud", name: "Claude API", type: "cloud" }];

test("what a version adds is what the update is sent with: ticked, by kind, each agent on its harness", () => {
  expect(needsReview({ conflicts: [], changes: [], additions })).toBe(true);
  const all = new Set(additions.map((a) => a.key));
  // An agent takes the harness picked, else the first of the kind it is written for.
  expect(addOf(additions, all, {}, harnesses)).toEqual({ primitives: ["Invoices"], agents: [{ name: "Billing", harnessId: "h_cloud" }], triggers: ["Invoice due"], skills: ["billing"] });
  expect(addOf(additions, all, { Billing: "h_cli" }, harnesses)?.agents).toEqual([{ name: "Billing", harnessId: "h_cli" }]);
  expect(addOf(additions, new Set(["trigger:Invoice due"]), {}, harnesses)).toEqual({ triggers: ["Invoice due"] });
  expect(addOf(additions, new Set(), {}, harnesses)).toBeUndefined();
  // No harness to run it on: the agent can't be added.
  expect(addOf(additions, all, {}, [])?.agents).toBeUndefined();
});

test("each addition is a box to tick, and a ticked agent asks for its harness", async () => {
  const pick = vi.fn();
  render(<UpdatePlan conflicts={[]} changes={[]} names={{}} take={[]} busy={false} onTake={() => {}} additions={additions} picked={new Set(["agent:Billing"])} harnessOf={{}} harnesses={harnesses} onPick={pick} onHarness={() => {}} />);
  const added = screen.getByRole("group", { name: "New in this version" });
  expect((within(added).getByRole("checkbox", { name: /^Billing/ }) as HTMLInputElement).checked).toBe(true);
  expect((within(added).getByRole("checkbox", { name: /Invoices/ }) as HTMLInputElement).checked).toBe(false);
  expect(within(added).getByRole("combobox", { name: "Harness of Billing" }).textContent).toContain("Claude API");
  expect(added.textContent).toContain("Prepares invoices.");
  await userEvent.click(within(added).getByRole("checkbox", { name: /Invoices/ }));
  expect(pick).toHaveBeenCalledWith("primitive:Invoices");
});
