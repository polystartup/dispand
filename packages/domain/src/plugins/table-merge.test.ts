import { expect, test } from "vitest";
import type { PrimitiveDefinition } from "./definitions.ts";
import { type ActualTable, tableChanges } from "./table-merge.ts";

const kept: PrimitiveDefinition = {
  name: "Matters",
  primitive: true,
  fields: [
    { name: "Clients", type: "reference", references: "Clients" },
    { name: "Conclusions", type: "long-text" },
    { name: "Stage", type: "single-select", choices: [{ id: "open", label: "Open" }, { id: "closed", label: "Closed" }] },
  ],
  parent: { field: "Clients", required: false },
};
const actual: ActualTable = {
  primitive: true,
  parentField: "Clients",
  parentRequired: false,
  fields: [
    { id: "f0", name: "Name", type: "text", choices: [], pluginField: null },
    { id: "f1", name: "Clients", type: "reference", choices: [], pluginField: "Clients" },
    { id: "f2", name: "Conclusions", type: "long-text", choices: [], pluginField: "Conclusions" },
    { id: "f3", name: "Stage", type: "single-select", choices: [{ id: "open", label: "Open" }, { id: "closed", label: "Closed" }], pluginField: "Stage" },
  ],
};
const exists = (name: string) => ["clients", "matters"].includes(name.toLowerCase());
const next = (change: (d: PrimitiveDefinition) => void) => {
  const d = structuredClone(kept);
  change(d);
  return d;
};
const kinds = (d: PrimitiveDefinition, a: ActualTable = actual, rows = 3) => tableChanges(kept, d, a, rows, exists).map(({ kind, field, ticked, loses, stale, waiting }) => ({ kind, field, ticked, ...(loses ? { loses } : {}), ...(stale ? { stale } : {}), ...(waiting ? { waiting } : {}) }));

test("nothing changed upstream is no change", () => {
  expect(tableChanges(kept, structuredClone(kept), actual, 3, exists)).toEqual([]);
});

test("a field added starts ticked; one removed or retyped starts unticked and says what it loses", () => {
  expect(kinds(next((d) => d.fields.push({ name: "Fee", type: "number" })))).toEqual([{ kind: "add", field: "Fee", ticked: true }]);
  expect(kinds(next((d) => (d.fields = d.fields.filter((f) => f.name !== "Conclusions"))))).toEqual([{ kind: "remove", field: "Conclusions", ticked: false, loses: 3 }]);
  expect(kinds(next((d) => (d.fields[1]!.type = "text")))).toEqual([{ kind: "retype", field: "Conclusions", ticked: false, loses: 3 }]);
});

test("choices only added start ticked; a choice removed or replaced starts unticked", () => {
  expect(kinds(next((d) => d.fields[2]!.choices!.push({ id: "won", label: "Won" })))).toEqual([{ kind: "choices", field: "Stage", ticked: true }]);
  expect(kinds(next((d) => (d.fields[2]!.choices = [{ id: "open", label: "Open" }, { id: "won", label: "Won" }])))).toEqual([{ kind: "choices", field: "Stage", ticked: false, loses: 3 }]);
});

test("a move starts ticked; the primitive flag and the parent start unticked", () => {
  expect(kinds(next((d) => d.fields.reverse()))).toEqual([{ kind: "move", field: undefined, ticked: true }]);
  expect(kinds(next((d) => (d.primitive = false)))).toEqual([{ kind: "primitive", field: undefined, ticked: false }]);
  expect(kinds(next((d) => (d.parent = { field: "Clients", required: true })))).toEqual([{ kind: "parent", field: undefined, ticked: false }]);
});

test("a field renamed upstream reads as one added and one removed: nothing is lost by default", () => {
  expect(kinds(next((d) => (d.fields[1]!.name = "Findings")))).toEqual([
    { kind: "add", field: "Findings", ticked: true },
    { kind: "remove", field: "Conclusions", ticked: false, loses: 3 },
  ]);
});

test("a change to something the owner changed is stale and can't be applied; one the owner already removed is nothing", () => {
  const retyped: ActualTable = { ...actual, fields: actual.fields.map((f) => (f.name === "Conclusions" ? { ...f, type: "text" } : f)) };
  expect(kinds(next((d) => (d.fields[1]!.type = "rich-text" as never)), retyped)).toEqual([{ kind: "retype", field: "Conclusions", ticked: false, stale: "You changed this field" }]);
  const gone: ActualTable = { ...actual, fields: actual.fields.filter((f) => f.name !== "Conclusions") };
  expect(kinds(next((d) => (d.fields = d.fields.filter((f) => f.name !== "Conclusions"))), gone)).toEqual([]);
  // A field of the owner's already has the name: the plugin's can't be added beside it.
  const named: ActualTable = { ...actual, fields: [...actual.fields, { id: "f9", name: "fee", type: "text", choices: [], pluginField: null }] };
  expect(kinds(next((d) => d.fields.push({ name: "Fee", type: "number" })), named)).toEqual([{ kind: "add", field: "Fee", ticked: false, stale: "A field of yours is called so" }]);
});

test("a change naming a table that doesn't exist yet waits for it", () => {
  expect(kinds(next((d) => d.fields.push({ name: "Invoice", type: "reference", references: "Invoices" })))).toEqual([{ kind: "add", field: "Invoice", ticked: false, waiting: "Invoices" }]);
});

test("a choice that keeps its label under a new id is a replacement: unticked, and it says what it loses", () => {
  expect(kinds(next((d) => (d.fields[2]!.choices = [{ id: "open2", label: "Open" }, { id: "closed", label: "Closed" }, { id: "won", label: "Won" }])))).toEqual([{ kind: "choices", field: "Stage", ticked: false, loses: 3 }]);
});

test("whatever the owner changed is stale for every kind of change: a removal, a move, the primitive flag, the parent", () => {
  const retyped: ActualTable = { ...actual, fields: actual.fields.map((f) => (f.name === "Conclusions" ? { ...f, type: "text" } : f)) };
  expect(kinds(next((d) => (d.fields = d.fields.filter((f) => f.name !== "Conclusions"))), retyped)).toEqual([{ kind: "remove", field: "Conclusions", ticked: false, stale: "You changed this field" }]);
  const reordered: ActualTable = { ...actual, fields: [actual.fields[0]!, actual.fields[2]!, actual.fields[1]!, actual.fields[3]!] };
  expect(kinds(next((d) => d.fields.reverse()), reordered)).toEqual([{ kind: "move", field: undefined, ticked: false, stale: "You changed the order" }]);
  const noParent: ActualTable = { ...actual, parentField: null };
  expect(kinds(next((d) => (d.parent = { field: "Clients", required: true })), noParent)).toEqual([{ kind: "parent", field: undefined, ticked: false, stale: "You changed it" }]);
});

test("changing what a reference field names isn't offered as something that can be applied here", () => {
  expect(kinds(next((d) => (d.fields[0]!.references = "Matters")))).toEqual([{ kind: "retype", field: "Clients", ticked: false, stale: "It can't be applied here: change the field by hand" }]);
  expect(kinds(next((d) => (d.fields[1] = { name: "Conclusions", type: "reference", references: "Clients" })))).toEqual([{ kind: "retype", field: "Conclusions", ticked: false, stale: "It can't be applied here: change the field by hand" }]);
});
