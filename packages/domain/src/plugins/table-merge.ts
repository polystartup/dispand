import type { PrimitiveDefinition } from "./definitions.ts";

// A plugin's table belongs to both sides: the plugin defines fields, the owner adds their own and
// fills the rows. So an update doesn't override a table: it compares the definition the table
// was last merged with to the new one, and lists each difference with a box the owner ticks.
// What adds starts ticked; what deletes values, or changes which rows the table accepts, doesn't.

/** The table as it is now: its fields (each with the plugin field it was made from), its primitive flag and its parent field's name. */
export type ActualTable = {
  primitive: boolean;
  parentField: string | null;
  fields: { id: string; name: string; type: string; choices: { id: string; label: string }[]; pluginField: string | null }[];
};

export type TableChange = {
  /** What the update is told to apply, among the table's: `<kind>:<field>` or `<kind>`. */
  key: string;
  kind: "add" | "remove" | "retype" | "choices" | "move" | "primitive" | "parent";
  field?: string;
  ticked: boolean;
  /** The rows whose values it would take away. */
  loses?: number;
  /** Why it can't be applied: the owner changed what it would change. */
  stale?: string;
  /** The table it names that isn't there yet: offered again once it is. */
  waiting?: string;
};

type Field = PrimitiveDefinition["fields"][number];
const lower = (s: string) => s.toLowerCase();
const find = (fields: Field[], name: string) => fields.find((f) => lower(f.name) === lower(name));
const labels = (choices: { label: string }[] | undefined) => (choices ?? []).map((c) => c.label);

/** The differences between `kept` (the definition the table was last merged with) and `next`, each with its starting tick, in the order they apply. */
export function tableChanges(kept: PrimitiveDefinition, next: PrimitiveDefinition, actual: ActualTable, rows: number, tableExists: (name: string) => boolean): TableChange[] {
  const changes: TableChange[] = [];
  const mine = (name: string) => actual.fields.find((f) => f.pluginField !== null && lower(f.pluginField) === lower(name));
  const loses = rows > 0 ? { loses: rows } : {};

  for (const f of next.fields.filter((f) => !find(kept.fields, f.name))) {
    const at = { key: `add:${f.name}`, kind: "add" as const, field: f.name };
    if (f.references && !tableExists(f.references)) changes.push({ ...at, ticked: false, waiting: f.references });
    else if (actual.fields.some((a) => lower(a.name) === lower(f.name))) changes.push({ ...at, ticked: false, stale: "A field of yours is called so" });
    else changes.push({ ...at, ticked: true });
  }
  for (const f of kept.fields.filter((f) => !find(next.fields, f.name))) {
    // Already gone: there is nothing to remove.
    if (mine(f.name)) changes.push({ key: `remove:${f.name}`, kind: "remove", field: f.name, ticked: false, ...loses });
  }
  for (const was of kept.fields) {
    const now = find(next.fields, was.name);
    const field = mine(was.name);
    if (!now || !field) continue;
    const changed = field.type !== was.type || labels(field.choices).join("\n") !== labels(was.choices).join("\n");
    const stale = changed ? { stale: "You changed this field" } : {};
    if (now.type !== was.type || (now.references ?? null) !== (was.references ?? null)) {
      changes.push({ key: `retype:${was.name}`, kind: "retype", field: was.name, ticked: false, ...(changed ? stale : loses) });
    } else if (labels(now.choices).join("\n") !== labels(was.choices).join("\n")) {
      const onlyAdded = labels(was.choices).every((label) => labels(now.choices).includes(label));
      changes.push({ key: `choices:${was.name}`, kind: "choices", field: was.name, ticked: !changed && onlyAdded, ...(changed ? stale : onlyAdded ? {} : loses) });
    }
  }
  // The order of the fields both versions define.
  const order = (fields: Field[]) => fields.map((f) => lower(f.name)).filter((n) => find(kept.fields, n) && find(next.fields, n));
  if (order(kept.fields).join("\n") !== order(next.fields).join("\n")) changes.push({ key: "move", kind: "move", ticked: true });
  if (kept.primitive !== next.primitive) changes.push({ key: "primitive", kind: "primitive", ticked: false, ...(actual.primitive !== kept.primitive ? { stale: "You changed it" } : {}) });
  const parent = (p: PrimitiveDefinition["parent"]) => (p ? `${lower(p.field)}:${p.required}` : "");
  if (parent(kept.parent) !== parent(next.parent)) {
    const references = next.parent ? find(next.fields, next.parent.field)?.references : undefined;
    changes.push({ key: "parent", kind: "parent", ticked: false, ...(references && !tableExists(references) ? { waiting: references } : {}) });
  }
  return changes;
}
